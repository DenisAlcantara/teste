# Notas de arquitetura

Este documento descreve o comportamento arquitetural implementado hoje no projeto.

## 1) Caminho sincrono (request)

Fluxo de `POST /messages`:

1. `JwtAuthGuard` valida token.
2. `ValidationPipe` valida DTO.
3. `IdempotencyInterceptor` tenta `PutItem` condicional na `idempotency-table`.
4. Se a chave foi adquirida, segue para `MessagesService.create`.
5. `MessagesService.create` persiste a mensagem no DynamoDB.
6. Depois tenta publicar `message.created` no Kafka.

Comportamento da idempotencia:

- `acquired`: segue processamento.
- `in_progress`: retorna `409` (request em voo).
- `completed`: devolve resposta cacheada com o mesmo `statusCode` e `responseBody`.

Observacao:

- O cache idempotente vale para sucesso e para erros `4xx` reproduziveis.
- Para erros `5xx`, a chave e liberada para permitir novo processamento em retry.

## 2) Caminho assincrono (worker)

Fluxo do consumidor Kafka:

1. Worker consome do topico `message-events` no consumer group `messages-worker`.
2. Faz parse do payload.
3. Executa `process(event)` com retry local e backoff exponencial.
4. Ao esgotar tentativas, envia para `message-events-dlq` com headers de diagnostico.

Headers de DLQ usados:

- `dlqReason`
- `dlqError`
- `dlqOriginalTopic`
- `dlqOriginalPartition`
- `dlqOriginalOffset`

## 3) Transicao de status

Fluxo de `PATCH /messages/:id/status`:

1. Busca mensagem atual (`findById`).
2. Valida transicao no service via `canTransition` (`enviado -> recebido -> lido`).
3. Atualiza no Dynamo com `ConditionExpression` para proteger concorrencia.
4. Publica evento `message.status_changed` (best effort).

Garantias:

- Regra de negocio: transicoes invalidas retornam `409`.
- Concorrencia: conflito no update tambem retorna `409`.

## 4) Modelagem DynamoDB

### messages-table

- PK/SK: `MSG#<uuid>`
- GSI1 (`GSI1-sender`):
  - `GSI1PK = SENDER#<sender>`
  - `GSI1SK = <sentAtIso>#<id>`
- GSI2 (`GSI2-date`):
  - `GSI2PK = DATE#<yyyy-mm-dd>`
  - `GSI2SK = <sentAtIso>#<id>`

### idempotency-table

- PK: `IDEMP#<key>`
- TTL: atributo `ttl`
- payload cacheado: `status`, `statusCode`, `responseBody`

## 5) Queries e paginacao

### Por sender

- Endpoint: `GET /messages?sender=...`
- Le em GSI1.
- Retorna `cursor` (base64 do `LastEvaluatedKey`).

### Por periodo

- Endpoint: `GET /messages?startDate=...&endDate=...`
- Janela maxima: 31 dias.
- Sem cursor para cliente (single-page).
- Internamente, para cada dia do range:
  - pagina ate consumir todo `LastEvaluatedKey` daquele dia;
  - junta resultados;
  - ordena por `sentAt` desc;
  - aplica `limit` final.


## 6) Kafka e ordering

- Topic principal: `message-events`
- Key de producao: `messageId`

Consequencia:

- Eventos da mesma mensagem tendem a cair na mesma partition, preservando ordem por `messageId`.

## 7) Diagrama

- `docs/architecture.drawio`: diagrama de apoio da solucao.
