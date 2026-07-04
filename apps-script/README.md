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

| NOME COMPLETO | E-MAIL | SENHA | PERFIL | ANDAMENTO |
|---|---|---|---|---|

- **PERFIL**: use `Administrador` ou `Atendente`.
- **ANDAMENTO**: preenchido automaticamente pelo sistema (ex.: `57%`).
- **Login**: valida a coluna `SENHA` (a coluna `SENHA TEMPORARIA`, se existir, também é aceita).

As abas **Progresso**, **Comentarios** e **Conteudo** são criadas automaticamente.

## Contrato da API (referência)

`POST` com corpo JSON `{ "action": "...", ... }`:

| action | envia | retorna |
|---|---|---|
| `login` | email, senha | `{ok, nome, email, perfil}` ou `{ok:false, error:"senha"\|"usuario"}` |
| `getState` | email | `{ok, nome, perfil, concluidos:[...]}` |
| `setProgress` | email, topic, done, total | `{ok, concluidos:[...], percent}` |
| `getComments` | topic | `{ok, comments:[...]}` |
| `addComment` | email, topic, texto | `{ok}` |
| `getContent` | topic | `{ok, blocks:[...]}` |
| `addContent` | email, topic, tipo, valor | `{ok}` ou `{ok:false, error:"perfil"}` (só admin) |
