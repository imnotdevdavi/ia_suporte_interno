# Deploy na Vercel

Este projeto foi ajustado para rodar na Vercel com:

- Express exportado em `server.js`
- Postgres gerenciado via `DATABASE_URL`
- arquivos persistidos em Vercel Blob privado
- logs via painel da Vercel

## 1. Pré-requisitos

- Projeto na Vercel conectado ao repositório
- Banco Postgres gerenciado criado
- Blob store privado criado na Vercel
- Credenciais do Google OAuth e do Notion em mãos

## 2. Variáveis de ambiente

Configure no projeto da Vercel:

```env
NODE_ENV=production
TRUST_PROXY=1
DATABASE_URL=postgres://USER:PASS@HOST:5432/smartai
OPENAI_API_KEY=
NOTION_TOKEN=
BLOB_READ_WRITE_TOKEN=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://SEU_DOMINIO/api/auth/google/callback
```

O app aceita `DATABASE_URL` e também `POSTGRES_URL`. Se o provedor conectado pela Vercel preencher `POSTGRES_URL` automaticamente, o backend já consegue usar esse valor.

## 3. Banco de dados

Rode as migrations no banco de produção antes de liberar o tráfego:

```bash
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" \
  -f db/migrations/001_initial_schema.sql \
  -f db/migrations/002_google_oauth_and_chat_delete.sql
```

## 4. Google OAuth

No Google Cloud Console, cadastre exatamente:

- Authorized JavaScript origin: `https://SEU_DOMINIO`
- Authorized redirect URI: `https://SEU_DOMINIO/api/auth/google/callback`

## 5. Publicação

1. Faça o primeiro deploy em preview.
2. Valide login, chat, anexos e foto de perfil.
3. Promova para produção.
4. Aponte o domínio final para a Vercel.

## 6. Smoke test

- `GET /api/health`
- cadastro e login por e-mail
- login com Google
- criação de chat
- envio de pergunta com streaming
- upload de foto de perfil
- upload e download de anexos
- exclusão de chat

## 7. Limites atuais do deploy

- até 3 anexos por envio
- até 4MB somados por requisição com anexos
- foto de perfil com até 4MB

Esses limites foram deixados assim para respeitar o modelo serverless da Vercel usando upload via servidor. Se no próximo passo você quiser uploads maiores, a evolução natural é migrar anexos para client upload direto no Blob.

## 8. O que não usar mais neste deploy

- `PORT` manual em produção
- `SMARTAI_STORAGE_DIR` para persistência de produção
- `SMARTAI_LOG_FILE` para logs de produção
- `nginx`, `systemd` e os diretórios `/var/lib/...`

## 9. Observabilidade

- logs: painel da Vercel
- arquivos: Vercel Blob
- banco: painel do provedor Postgres
