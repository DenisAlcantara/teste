# API de Mensagens (NestJS + DynamoDB + Kafka)

Este projeto implementa uma API de mensagens com foco em consistência, idempotência e rastreabilidade.
A ideia foi manter o desenho simples para o desafio, sem abrir mão de boas práticas de backend.

- API REST em NestJS 10
- Persistência em DynamoDB (single-table)
- Publicação de eventos em Kafka
- Worker com retry e DLQ
- Fluxo autenticado via JWT (login stub para teste)
- CORS configurável por env e rate-limit no login

## Como rodar localmente

### Pré-requisitos

- Node 20+
- Docker + Docker Compose

### Passo a passo

```bash
npm install
npm run infra:up
```

Crie o `.env` a partir do exemplo:

- Linux/macOS
```bash
cp .env.example .env
```

- Windows PowerShell
```powershell
Copy-Item .env.example .env
```

Suba API e worker em terminais separados:

```bash
npm run start:dev
npm run worker:dev
```

Para derrubar a infra:

```bash
npm run infra:down
```

## Scripts principais

- `npm run build`
- `npm run start:prod`
- `npm run start:worker`
- `npm run test`
- `npm run test:unit`
- `npm run test:e2e`
- `npm run lint`

Observação: o build gera artefatos em `dist-build/`.

## Endpoints

Os endpoints de `/messages` exigem `Authorization: Bearer <accessToken>`.
O token pode ser obtido em `POST /auth/login`.

| Método | Caminho | Notas |
| --- | --- | --- |
| POST | `/auth/login` | Demo: valida `username` + `DEMO_PASSWORD` da env (sem IdP real) |
| POST | `/messages` | Aceita `Idempotency-Key` |
| GET | `/messages/:id` | Busca por id |
| GET | `/messages?sender=...` | Consulta por sender, com cursor |
| GET | `/messages?startDate=...&endDate=...` | Consulta por período (max 31 dias), sem cursor |
| PATCH | `/messages/:id/status` | Status: `enviado`, `recebido`, `lido` |

Regras de consulta:

- `sender` e `startDate/endDate` são mutuamente exclusivos
- `startDate` e `endDate` devem vir juntos
- `cursor` com date-range retorna `400`

## Fluxo de eventos

```text
   ┌────────┐         ┌───────────────────┐         ┌──────────────┐
   │ Client │         │     NestJS API    │         │   DynamoDB   │
   │  HTTP  │ ──────► │  Auth + Idempot.  │ ──────► │ messages     │
   │ Bearer │         │  FSM (canTrans.)  │         │ idempotency  │
   └────────┘         └─────────┬─────────┘         └──────────────┘
                                │  message.created
                                ▼
                       ┌──────────────────┐
                       │      Kafka       │
                       │ topic:           │
                       │ message-events   │
                       └─────────┬────────┘
                                 │
                                 ▼
                       ┌──────────────────┐    retry esgotado
                       │     Worker       │ ─────────────────────┐
                       │ (consumer group: │                      │
                       │  messages-worker)│                      ▼
                       └─────────┬────────┘            ┌──────────────────┐
                                 │ ok                  │       DLQ        │
                                 ▼                     │ message-events-  │
                          (processa evento)            │       dlq        │
                                                       └──────────────────┘
```

Notas do fluxo:

1. API persiste no Dynamo **antes** de publicar no Kafka (source of truth = Dynamo).
2. Producer Kafka é idempotente, `key = messageId` preserva ordenação por mensagem.
3. Worker faz retry com backoff exponencial; ao esgotar, envia para DLQ com headers de diagnóstico.

## Modelagem DynamoDB

### `messages-table`

- PK/SK: `MSG#<uuid>`
- GSI1 (`GSI1-sender`)
  - `GSI1PK = SENDER#<sender>`
  - `GSI1SK = <sentAtIso>#<id>`
- GSI2 (`GSI2-date`)
  - `GSI2PK = DATE#<yyyy-mm-dd>`
  - `GSI2SK = <sentAtIso>#<id>`

### `idempotency-table`

- PK: `IDEMP#<key>`
- TTL no atributo `ttl`
- Cache de `status`, `statusCode` e `responseBody` para replay determinístico

## Decisões de arquitetura

### 1) FSM em duas camadas

- Camada de serviço valida a regra de transição (`enviado -> recebido -> lido`) via `canTransition`
- Persistência protege concorrência via `ConditionExpression`

Resumo: uma camada protege regra de negócio, a outra protege consistência sob corrida.

### 2) Idempotência key-only

Com a mesma `Idempotency-Key`, o cliente recebe a mesma resposta já registrada.
Isso vale para sucesso e para erros `4xx` reproduzíveis (ex.: 400).
Para `5xx`, a chave é liberada para permitir novo processamento em retry.

### 3) Consulta por período sem cursor externo

`GET` por período foi mantido como single-page (janela de 31 dias + `limit`).
Internamente, cada dia pagina até consumir `LastEvaluatedKey`, depois o resultado é ordenado e limitado.

### 4) Persistência antes de publish

Fluxo de criação:

1. Salva no Dynamo
2. Publica `message.created` no Kafka

Se o publish falhar, a mensagem continua persistida (source of truth = Dynamo).
Em produção, o passo natural é adotar transactional outbox.

## Worker e DLQ

- Consumer group: `messages-worker`
- Retry com backoff exponencial
- Ao esgotar tentativas, envia para `message-events-dlq` com headers de diagnóstico

## Autenticação

`/auth/login` valida `username` e a senha contra `DEMO_PASSWORD` da env (demo, sem `users-table`/`bcrypt`).
JWT access token assinado com `JWT_ACCESS_SECRET` e expiração configurável via `JWT_ACCESS_TTL`.
Em produção, substituir o login por IdP (Cognito, IdP corporativo) — o restante do pipeline já serve.

Rate-limit: `/auth/login` aceita no máximo 5 tentativas por IP a cada 60s (`@nestjs/throttler`).
Demais rotas têm um teto global de 120 req/min/IP como defesa em profundidade.

## CORS

`CORS_ORIGINS` aceita `*` (apenas dev) ou lista separada por vírgula com as origens permitidas.
Headers expostos: `x-request-id`. Headers aceitos: `Authorization`, `Content-Type`, `Idempotency-Key`, `x-request-id`.

## Testes

- Unit: regras de status, DTOs e service com mocks
- E2E: API completa com supertest, Dynamo real e publisher mockado

## Log de decisões

- **Single-table**: os padrões de acesso dirigem o schema; separar por entidade aumentaria custo e complexidade de consistência.
- **FSM em duas camadas**: service faz fast-fail de regra inválida e DB protege race condition no update.
- **Auth com IdP stub deliberado**: login valida contra `DEMO_PASSWORD` env; o resto do pipeline JWT (guard, strategy, expiração) é real. Sem `users-table`/`bcrypt` por escopo — em prod entra IdP externo.
- **nestjs-pino com `genReqId`**: request id nativo, propagação de `x-request-id` e menos código customizado.
- **Worker Nest separado**: deploy, restart e escala independentes da API.
- **Kafka em KRaft**: stack mais simples localmente e alinhada ao caminho atual do ecossistema Kafka.
- **Producer idempotente com `key=messageId`**: melhora resiliência de publish e preserva ordenação por mensagem (por partition/key).
- **Rate-limit no login**: defesa contra brute-force no stub de auth;
- **CORS por env**: app está preparada para front-end em outro domínio sem alterar código.

## Estrutura do projeto

```text
src/
  messages/
    dto/
    events.ts
    kafka.publisher.ts
    message.types.ts
    messages.controller.ts
    messages.module.ts
    messages.repository.ts
    messages.service.ts
  shared/
    auth/
    idempotency/
    infrastructure/
    logger/
    filters/
  worker/
  config/
  main.ts
  worker.ts
```
