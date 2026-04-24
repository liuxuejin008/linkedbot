from flask import Flask, request

app = Flask(__name__)

@app.route('/webhook', methods=['POST'])
def webhook_receiver():
    # 1. 获取请求体内容 (JSON 或 文本)
    data = request.get_data(as_text=True)
    
    # 2. 打印接收到的信息，方便调试
    print("--- 收到 Webhook 消息 ---")
    print(f"Header: {dict(request.headers)}")
    print(f"Body: {data}")
    print("-----------------------")

    # 3. 返回 OK 给发送者
    return "OK1111", 200

if __name__ == '__main__':
    # 启动服务，监听 5000 端口
    # 在内网测试建议保持 debug=True 方便看报错
    app.run(host='0.0.0.0', port=5001, debug=True)