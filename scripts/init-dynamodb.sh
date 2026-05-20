#!/bin/sh
set -e

DYNAMO_ENDPOINT=http://dynamodb:8000

echo "==> Creating DynamoDB tables..."

# messages-table: single-table design
# PK = MSG#<id>, SK = MSG#<id>
# GSI1 (sender): SENDER#<sender> / <ISO>#<id>
# GSI2 (date):   DATE#<yyyy-mm-dd> / <ISO>#<id>
# Sharding intentionally omitted — UUID v4 on PK distributes uniformly.
# Add GSI shard suffix when GSI write throttle or hot-partition alarms fire.
aws dynamodb create-table \
  --endpoint-url $DYNAMO_ENDPOINT \
  --table-name messages-table \
  --attribute-definitions \
    AttributeName=PK,AttributeType=S \
    AttributeName=SK,AttributeType=S \
    AttributeName=GSI1PK,AttributeType=S \
    AttributeName=GSI1SK,AttributeType=S \
    AttributeName=GSI2PK,AttributeType=S \
    AttributeName=GSI2SK,AttributeType=S \
  --key-schema \
    AttributeName=PK,KeyType=HASH \
    AttributeName=SK,KeyType=RANGE \
  --global-secondary-indexes \
    "IndexName=GSI1-sender,KeySchema=[{AttributeName=GSI1PK,KeyType=HASH},{AttributeName=GSI1SK,KeyType=RANGE}],Projection={ProjectionType=ALL}" \
    "IndexName=GSI2-date,KeySchema=[{AttributeName=GSI2PK,KeyType=HASH},{AttributeName=GSI2SK,KeyType=RANGE}],Projection={ProjectionType=ALL}" \
  --billing-mode PAY_PER_REQUEST \
  2>/dev/null || echo "messages-table already exists"

# idempotency-table: TTL-managed dedup
aws dynamodb create-table \
  --endpoint-url $DYNAMO_ENDPOINT \
  --table-name idempotency-table \
  --attribute-definitions AttributeName=PK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  2>/dev/null || echo "idempotency-table already exists"

aws dynamodb update-time-to-live \
  --endpoint-url $DYNAMO_ENDPOINT \
  --table-name idempotency-table \
  --time-to-live-specification "Enabled=true,AttributeName=ttl" \
  2>/dev/null || echo "TTL already enabled on idempotency-table"

echo "==> DynamoDB ready."
