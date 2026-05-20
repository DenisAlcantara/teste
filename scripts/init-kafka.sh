#!/bin/bash
set -e

BOOTSTRAP=kafka:9092

echo "==> Creating Kafka topics..."

# Main events topic: 3 partitions allow per-message ordering via key=messageId
kafka-topics.sh --bootstrap-server $BOOTSTRAP \
  --create --if-not-exists \
  --topic message-events \
  --partitions 3 \
  --replication-factor 1 \
  --config retention.ms=604800000 \
  --config min.insync.replicas=1

# DLQ topic: 1 partition is fine, ordering not critical for inspection
kafka-topics.sh --bootstrap-server $BOOTSTRAP \
  --create --if-not-exists \
  --topic message-events-dlq \
  --partitions 1 \
  --replication-factor 1 \
  --config retention.ms=2592000000 \
  --config min.insync.replicas=1

echo "==> Listing topics:"
kafka-topics.sh --bootstrap-server $BOOTSTRAP --list

echo "==> Kafka ready."
