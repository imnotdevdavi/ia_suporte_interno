# Banco de dados SmartAI

O schema inicial foi desenhado em cima do código atual do projeto:

- `users`: perfil do colaborador, tema do site, foto e status da conta.
- `auth_sessions`: sessões de login persistentes.
- `chat_threads`: cada conversa salva do usuário.
- `chat_messages`: mensagens do usuário e da IA, incluindo `request_id`, modelo e tempos de resposta.
- `message_attachments`: anexos da conversa, com metadados e texto extraído quando existir.
- `assistant_message_sources`: fontes consultadas na resposta da IA.
- `message_feedback`: feedback rápido por mensagem, como "Útil" ou "Não útil".
- `knowledge_feedback_queue`: fila de curadoria para realimentação da base, sem escrever direto no Notion.

## Aplicar o schema

Com o Postgres local rodando e o database `smartai` já criado:

```bash
npm run db:init
```

Ou diretamente:

```bash
psql -d smartai -f db/migrations/001_initial_schema.sql -f db/migrations/002_google_oauth_and_chat_delete.sql
```

## Google OAuth

Para habilitar o login com Google, configure no `.env`:

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google/callback
```

Se `GOOGLE_REDIRECT_URI` não for definido, o servidor monta automaticamente usando a origem atual.

## Estratégia de realimentação recomendada

Em vez de atualizar a base do Notion automaticamente quando alguém marca uma resposta como ruim:

1. Grave o feedback em `message_feedback`.
2. Se houver correção, abra um item em `knowledge_feedback_queue`.
3. Um revisor interno aprova ou rejeita a mudança.
4. Só depois a correção é aplicada na base oficial.

Isso evita que erros ou opiniões entrem direto na fonte de verdade do sistema.
