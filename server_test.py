from flask import Flask, jsonify

app = Flask(__name__)

@app.route('/user', methods=['GET'])
def get_user():
    # 返回 JSON 数据
    return jsonify({
        "status": "ok",
        "message": "请求成功",
        "data": {
            "id": 1,
            "username": "flask_user"
        }
    })

if __name__ == '__main__':
    # debug=True 可以在修改代码后自动重启
    app.run(debug=True, port=8099)
