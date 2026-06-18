# ⚙️ Dominando o CMS: Operação e Diagnósticos

## 🔒 Arquitetura de Busca e Protocolo de Segurança
Para garantir a segurança de dados, o analista deve **obrigatoriamente confirmar pelo menos 2 dos itens abaixo** antes de concluir qualquer alteração ou passar informações sensíveis[cite: 2]:
1. Número do Pedido (Identificador principal)[cite: 2]
2. E-mail do Comprador (Ideal para histórico)[cite: 2]
3. CPF do Comprador[cite: 2]
4. Nome Completo do Passageiro[cite: 2]
5. Comprovante / Localizador da Viação[cite: 2]

---

## 🛠️ Resgate e Validação Manual (Troubleshooting)
Se o status da passagem estiver como **"Pendente Confirmação de Reservas"** (pagamento aprovado, mas a poltrona original foi perdida), execute uma das ações de resgate[cite: 2]:
*   **Refazer Nova Poltrona:** Selecione um novo assento na planta do mesmo ônibus/viação[cite: 2].
*   **Trocar Poltrona/Oferta:** Mude para um horário similar disponível no mesmo distribuidor[cite: 2].
*   **Recomprar Mesma Oferta:** Re-selecione a oferta original caso o bloqueio tenha caído[cite: 2].

> 📈 **Regra Financeira de Resgate:** Você possui autonomia prévia para confirmar tarifas com **até 10% de aumento** (buffer financeiro). Valores acima disso exigem autorização da supervisão[cite: 2].

---

## 🚨 Escalonamento: Quando abrir um SLA?
Abra um chamado de SLA no CMS (Status: *Aguardando*) apenas se identificar[cite: 2]:
*   Passagem não localizada no guichê da rodoviária[cite: 2].
*   Inexistência de percurso e/ou horário impresso no local[cite: 2].
*   Status da passagem alterado para *Cancelada* no ato do embarque[cite: 2].
*   Ônibus não compareceu ou atraso confirmado superior a 3 horas[cite: 2].
*   *Prazo de resolução:* 20 a 30 dias (o cliente é notificado por e-mail automaticamente)[cite: 2].
