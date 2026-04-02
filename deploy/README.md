# Deploy de Produção

Este pacote assume Ubuntu 24.04+, Node 20+, Postgres local ou gerenciado e o app em `/opt/smartai/app`.

## 1. Preparar o servidor

```bash
sudo adduser --system --group --home /opt/smartai smartai
sudo mkdir -p /opt/smartai/app /var/lib/smartai/storage /var/lib/smartai/tmp /var/log/smartai /var/backups/smartai
sudo chown -R smartai:smartai /opt/smartai /var/lib/smartai /var/log/smartai /var/backups/smartai
```

Instale dependências base:

```bash
sudo apt update
sudo apt install -y nginx postgresql-client certbot python3-certbot-nginx
```

## 2. Publicar o app

Copie o projeto para o servidor em `/opt/smartai/app`, entre na pasta e instale dependências:

```bash
cd /opt/smartai/app
npm ci
cp .env.production.example .env.production
```

Edite `.env.production` e preencha as credenciais reais.

## 3. Rodar migrations

```bash
cd /opt/smartai/app
bash deploy/scripts/run_migrations.sh
```

## 4. Ativar o serviço systemd

```bash
sudo cp deploy/systemd/smartai.service /etc/systemd/system/smartai.service
sudo systemctl daemon-reload
sudo systemctl enable --now smartai
sudo systemctl status smartai
```

## 5. Configurar Nginx

Copie o arquivo de site e ajuste `server_name`:

```bash
sudo cp deploy/nginx/smartai.conf /etc/nginx/sites-available/smartai
sudo ln -sf /etc/nginx/sites-available/smartai /etc/nginx/sites-enabled/smartai
sudo nginx -t
sudo systemctl reload nginx
```

Depois emita o HTTPS:

```bash
sudo certbot --nginx -d app.seudominio.com
```

## 6. Ativar backup automático

```bash
sudo cp deploy/systemd/smartai-backup.service /etc/systemd/system/smartai-backup.service
sudo cp deploy/systemd/smartai-backup.timer /etc/systemd/system/smartai-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now smartai-backup.timer
systemctl list-timers smartai-backup.timer
```

## 7. Atualização futura

```bash
cd /opt/smartai/app
git pull
npm ci
bash deploy/scripts/run_migrations.sh
sudo systemctl restart smartai
```

## 8. Expor com ngrok

Para demonstração antes do DNS final:

```bash
PORT=3000 bash deploy/scripts/start_ngrok.sh
```

Se `NGROK_AUTHTOKEN` estiver definido na sua `.env`, o script grava automaticamente a configuração local em `tools/ngrok/ngrok.yml`.

Para subir app + túnel de uma vez:

```bash
npm run tunnel
```

Se quiser proteger a URL:

```bash
NGROK_BASIC_AUTH="demo:SenhaForte123" PORT=3000 bash deploy/scripts/start_ngrok.sh
```

Quando você ativar o Google OAuth, use a URL HTTPS do `ngrok` como `GOOGLE_REDIRECT_URI` e cadastre exatamente o callback no Google Cloud. Se o domínio do `ngrok` mudar, o callback também precisa ser atualizado.

## Notas

- O rate limit implementado no app é local em memória. Em múltiplas réplicas, troque por Redis.
- `SMARTAI_STORAGE_DIR` e `SMARTAI_LOG_FILE` aceitam caminhos absolutos.
- Os textos de privacidade e termos em `public/` são um ponto de partida e precisam de revisão jurídica antes da publicação externa.
