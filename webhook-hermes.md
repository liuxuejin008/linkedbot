 hermes webhook subscribe process-order \
  --events "order.created" \
  --secret "INSECURE_NO_AUTH" \
  --prompt "你是一个订单处理 AI 助手。刚才我们的系统收到了一个新订单，详情如下：
- 订单编号：{payload.order_id}
- 客户姓名：{payload.customer_name}
- 订单金额：{payload.amount}
- 购买商品：{payload.items}

请你对这个订单进行风险评估，并生成一段友好的订单确认文案



curl -X POST http://127.0.0.1:8644/webhooks/process-order   -H "Content-Type: application/json"   -d '{
    "event_type": "order.created",
    "order_id": "ORD-20260506-991",
    "customer_name": "张三",
    "amount": "199.50",
    "items": "机械键盘 x1"
  }'