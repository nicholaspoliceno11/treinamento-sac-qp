# Backend do Portal (Google Apps Script)

O site é estático (GitHub Pages) e **não** consegue validar senhas nem gravar
progresso sozinho. Este Apps Script roda **dentro da sua planilha** (como dono),
mantém as senhas privadas e expõe uma pequena API que o site consome.

## Passo a passo (uma vez só)

1. Abra a planilha de login no Google Sheets.
2. Menu **Extensões → Apps Script**.
3. Apague o conteúdo do `Código.gs` e cole todo o conteúdo de [`Code.gs`](./Code.gs). Salve (💾).
4. O `SPREADSHEET_ID` já vem preenchido com o ID da sua planilha (então funciona mesmo
   em um editor não vinculado). Se o nome da aba de usuários não for exatamente
   **`Login Treinamento`**, ajuste a constante `LOGIN_SHEET` no topo do script.
5. Clique em **Implantar → Nova implantação**.
   - Tipo: **App da Web**.
   - **Executar como:** Eu (seu e-mail).
   - **Quem pode acessar:** **Qualquer pessoa**.
6. Autorize os acessos quando solicitado.
7. Copie a **URL do app da Web** (algo como `https://script.google.com/macros/s/AKfy.../exec`).
8. Cole essa URL em [`../assets/config.js`](../assets/config.js) no campo `API_URL` e faça o deploy do site.

> A cada alteração no `Code.gs`, use **Implantar → Gerenciar implantações → Editar → Nova versão**
> para publicar a mudança (a URL continua a mesma).

## Estrutura da planilha

Aba de usuários (linha 1 = cabeçalhos). As colunas são **detectadas pelo nome**,
então a ordem não importa e colunas extras são ignoradas. Cabeçalhos reconhecidos:

| NOME COMPLETO | E-MAIL | SENHA | PERFIL | ANDAMENTO | ACESSO BACKOFFICE *(opcional)* |
|---|---|---|---|---|---|

- **PERFIL**: use `Administrador`, `Backoffice` ou `Atendente`.
- **ACESSO BACKOFFICE** (controle do tópico 🖥️ Backoffice) — duas formas válidas:
  - **Opção A:** coluna `ACESSO BACKOFFICE` na aba **Login Treinamento** (`SIM` / `NÃO`), ou
  - **Opção B:** aba separada **`ACESSO BACKOFFICE`** com colunas `NOME` + `ACESSO` (`Sim` / `Não`). O nome deve ser igual ao da aba de login.
  - A coluna legada `ACESSO ACADEMIA` ainda é lida se `ACESSO BACKOFFICE` não existir.
  - Perfil **Backoffice** e **Administrador** têm acesso automático.
- **ANDAMENTO**: preenchido automaticamente pelo sistema (ex.: `57%`).
- **Login**: valida a coluna `SENHA` (a coluna `SENHA TEMPORARIA`, se existir, também é aceita).
  As senhas são gravadas como **hash SHA-256 com sal** (`sha256$...`). No primeiro login
  com senha em texto puro, o script converte automaticamente. Para migrar todas de uma vez,
  execute `migrateAllPasswordsInSheet` no editor Apps Script.
- **Senha forte recomendada**: mínimo 8 caracteres, 1 letra maiúscula, 1 número e 1 símbolo. Logins com senha
  fraca exibem opção de troca imediata no portal (`changePassword`). Usuários novos (coluna `TROCAR SENHA = SIM`) são obrigados a definir senha pessoal no primeiro acesso.

As abas **Progresso**, **Comentarios**, **Conteudo**, **Sessoes**, **LoginTentativas**, **Informativos**, **InformativoLeituras**, **InformativoComentarios** e **MilaFAQ** são criadas automaticamente.

## Segurança

| Medida | Comportamento |
|---|---|
| **Token de sessão** | O `login` devolve `sessionToken` (válido 12 h). Todas as demais ações exigem `sessionToken` — não basta enviar só o e-mail. |
| **Hash de senha** | Planilha guarda `sha256$<sal>$<hash>`, não texto puro. Migração automática no login ou em lote via `migrateAllPasswordsInSheet`. |
| **Anti brute-force** | Após 5 senhas erradas, bloqueio de 15 min por e-mail (`error: "bloqueado"`). |
| **Compartilhamento** | Restrinja quem tem acesso de edição à planilha — mesmo com hash, proteja o cadastro. |

## Contrato da API (referência)

`POST` com corpo JSON `{ "action": "...", ... }`.

Ações autenticadas exigem `sessionToken` (retornado no login). Ações com identidade do usuário
também exigem `email` correspondente à sessão.

| action | envia | retorna |
|---|---|---|
| `login` | email, senha | `{ok, sessionToken, nome, email, perfil, acessoBackoffice, mustChangePassword?, weakPassword?}` ou `{ok:false, error:"senha"\|"usuario"\|"bloqueado", retryAfter?, attemptsLeft?}` |
| `logout` | email, sessionToken | `{ok}` |
| `getState` | email, sessionToken | `{ok, nome, perfil, acessoBackoffice, concluidos:[...]}` ou `{ok:false, error:"auth"}` |
| `setProgress` | email, sessionToken, topic, done, total | `{ok, concluidos:[...], percent}` |
| `getComments` | sessionToken, topic | `{ok, comments:[...]}` |
| `addComment` | email, sessionToken, topic, texto | `{ok}` |
| `getContent` | sessionToken, topic | `{ok, blocks:[...]}` |
| `addContent` | email, sessionToken, topic, tipo, valor | `{ok}` ou `{ok:false, error:"perfil"}` (só admin) |
| `getDesafio` | email, sessionToken | `{ok, perguntas:[...], respostas:[...]}` — respostas só do próprio usuário |
| `addDesafioPergunta` | email, sessionToken, pergunta, opcoes `{A,B,C,D}`, correta, ativo | `{ok, id}` (só admin) |
| `submitDesafioResposta` | email, sessionToken, questaoId, escolha (`A`–`D`) | `{ok, acertou}` — pode refazer se errou |
| `listUsers` | email, sessionToken | `{ok, users:[...]}` (só admin) |
| `createUser` | email, sessionToken, adminSenha, user `{nome,email,senha,perfil,acessoBackoffice,bloqueado}` | `{ok}` (só admin) |
| `updateUser` | email, sessionToken, adminSenha, targetEmail, changes `{nome?,perfil?,acessoBackoffice?,bloqueado?,senha?}` | `{ok}` (só admin) |
| `deleteUser` | email, sessionToken, adminSenha, targetEmail | `{ok}` (só admin) |
| `changePassword` | email, sessionToken, senhaAtual, novaSenha | `{ok}` ou `{ok:false, error:"senha_atual"\|"senha_fraca"}` |
| `getInformativos` | email, sessionToken | `{ok, informativos:[...]}` — cada item: `{id, titulo, texto, autor, criadoEm, anexoTipo?, anexoValor?, anexoNome?, lido, totalLeituras, comentarios:[...]}`; admin também recebe `leituras:[{nome,email,perfil,ts}]` |
| `addInformativo` | email, sessionToken, titulo, texto, anexoTipo? (`imagem`\|`pdf`\|`video`), anexoValor? (foto data URI ou URL de vídeo), anexoBase64? + anexoMime? + anexoNome? (PDF/arquivo de vídeo → salvo no Google Drive) | `{ok, id}` (só admin) |
| `markInformativoRead` | email, sessionToken, informativoId | `{ok}` ou `{ok, jaLido:true}` — atendentes e backoffice confirmam leitura |
| `addInformativoComment` | email, sessionToken, informativoId, texto | `{ok, id}` |
| `askMila` | email, sessionToken, pergunta | `{ok, resposta, perguntaBase?, score?, semMatch?, sugestoes?}` — busca na base `MilaFAQ` |
| `getMilaSugestoes` | email, sessionToken | `{ok, sugestoes:[...]}` — até 6 perguntas ativas para exibir no chat |
| `getMilaFaq` | email, sessionToken | `{ok, faq:[...]}` (só admin) |
| `addMilaFaq` | email, sessionToken, pergunta, resposta, palavrasChave?, ativo? | `{ok, id}` (só admin) |
| `updateMilaFaq` | email, sessionToken, id, changes `{pergunta?, resposta?, palavrasChave?, ativo?}` | `{ok}` (só admin) |
| `deleteMilaFaq` | email, sessionToken, id | `{ok}` (só admin) |

Usuários bloqueados (`BLOQUEADO = SIM` na planilha) não conseguem fazer login. A coluna `BLOQUEADO` é criada automaticamente na primeira gestão pelo portal.

Abas **DesafioPerguntas** e **DesafioRespostas** são criadas automaticamente.
Cada atendente só recebe suas próprias respostas em `getDesafio`.
