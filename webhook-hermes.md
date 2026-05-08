# Webhook Hermes Example

> 📖 [中文版本 → webhook-hermes.zh.md](./webhook-hermes.zh.md)

```bash
hermes webhook subscribe process-order \
  --events "order.created" \
  --secret "INSECURE_NO_AUTH" \
  --prompt "You are an order processing AI assistant. Our system just received a new order with the following details:
- Order ID: {payload.order_id}
- Customer Name: {payload.customer_name}
- Order Amount: {payload.amount}
- Items: {payload.items}

Please perform a risk assessment for this order and generate a friendly order confirmation message."

curl -X POST http://127.0.0.1:8644/webhooks/process-order \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "order.created",
    "order_id": "ORD-20260506-991",
    "customer_name": "John Doe",
    "amount": "199.50",
    "items": "Mechanical Keyboard x1"
  }'
```