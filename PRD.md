# LinkedBot — Product Requirements Document (PRD)

> 📖 [中文版本 → PRD.zh.md](./PRD.zh.md)

---

## Overview

LinkedBot introduces a **Channel** object (previously called "bot") as the core unit. When creating a new Channel, there are two operating modes:

1. **Proxy Mode**
   - When an external system calls back the Channel's webhook URL, the Channel transparently relays the request to the local client (`Forwarded to localhost:9999/webhook`), waits for the local webhook response, and returns it to the external caller via the client → server path.

2. **Mailbox Mode**
   - When an external system calls back the Channel's webhook URL, the Channel saves the message to the database and immediately replies to the caller with a preset response (e.g. `{"code":"ok"}`). LinkedBot then **asynchronously** delivers the message to the local client process, which forwards it to `localhost:9999/webhook`.

---

## Use Cases

### Scenario 1: Local Development & Payment Callback Debugging

Developers working in an office without a public IP cannot normally receive callbacks from third-party payment systems (e.g., WeChat Pay, Alipay). With LinkedBot, the developer can:

1. Register an account on the LinkedBot website.
2. Create a **Proxy Mode** Channel.
3. Start a local client.

This allows WeChat Pay or Alipay to call back the local webhook without any self-hosted proxy infrastructure — ideal for independent developers.

> **Note**: Most webhooks use HTTP POST.

---

## System Architecture

### Components

| Component | Location | Role |
|-----------|----------|------|
| **ChannelServer** | Cloud / Public IP | Relay / Message hub |
| **ChannelClient** | Office intranet | Intranet tunnel agent |
| **ChannelReceiver** | Office intranet | Final business logic handler |

### Component Responsibilities

**ChannelServer (Public)**
- Provides a public endpoint to receive third-party callbacks.
- Maintains SSE connection pool with ChannelClients.
- Converts received HTTP bodies into SSE events for delivery.

**ChannelClient (Intranet)**
- Initiates connections to the Server (bypasses inbound firewall restrictions).
- Parses SSE event streams.
- Reconstructs data as local HTTP requests sent to ChannelReceiver.

**ChannelReceiver (Local)**
- Runs inside the intranet.
- Handles specific business logic (e.g., parsing alerts, auto deployment, controlling LAN devices, etc.).

---

## Mode 1: Proxy Mode

### Sequence Diagram

```mermaid
sequenceDiagram
    participant Web as External System (Webhook Source)
    participant CS as ChannelServer (Public)
    participant CC as ChannelClient (Intranet)
    participant CR as ChannelReceiver (Intranet)

    Note over CC, CS: [Init] ChannelClient connects SSE and keeps listening

    Web->>CS: 1. HTTP POST request (Webhook)
    activate CS
    Note right of CS: Generate ReqID, hold HTTP connection

    CS-->>CC: 2. Push data via SSE (ReqID + payload)
    
    activate CC
    CC->>CR: 3. Forward local request (POST /local)
    activate CR
    CR-->>CC: 4. Return result (Result JSON)
    deactivate CR

    CC->>CS: 5. Submit result (POST /callback {ReqID, Result})
    deactivate CC

    Note right of CS: Match pending request by ReqID
    CS-->>Web: 6. Return result synchronously (200 OK)
    deactivate CS
```

### Architecture Topology

```mermaid
graph TD
    subgraph Public_Internet ["Public Cloud / Internet"]
        Sender["External Sender"]
        Server["ChannelServer"]
    end

    subgraph Office_Internal_Network ["Office Intranet"]
        Client["ChannelClient"]
        Receiver["ChannelReceiver"]
    end

    Sender -- "1. Original Webhook Request (waiting)" --> Server
    Server -. "2. SSE tunnel push (ReqID)" .-> Client
    Client -- "3. Local HTTP call" --> Receiver

    Receiver -- "4. Return result" --> Client
    Client -- "5. HTTP POST submit result (ReqID)" --> Server
    Server -- "6. End wait, return result" --> Sender

    style Server fill:#f9f,stroke:#333,stroke-width:2px
    style Client fill:#bbf,stroke:#333,stroke-width:2px
    style Sender fill:#fff
    style Receiver fill:#fff
```

### Key Architecture Points

| Point | Description |
|-------|-----------------|
| **ReqID** | ChannelServer must generate a unique ID per webhook call, and include it in SSE messages, so results can be matched back to pending requests. |
| **Request Parking** | The webhook handler must not return immediately; it must await the callback using a Promise/Future/Channel mechanism. |
| **Timeout** | A timeout (e.g., 10–30s) must be set. If no result is received, the server returns `504 Gateway Timeout`. |
| **Return Path** | The client returns results by making a new HTTP POST to the Server's `/api/callback` — SSE is one-way only. |

---

## Mode 2: Mailbox Mode

### Architecture Topology

```mermaid
graph TD
    subgraph Public_Internet ["Public Cloud / Internet"]
        Sender["External Webhook Sender<br/>e.g. GitHub, Feishu, DingTalk"]
        Server["ChannelServer<br/>Public IP"]
    end

    subgraph Office_Internal_Network ["Office LAN / Intranet"]
        direction TB
        Client["ChannelClient<br/>SSE Client"]
        Receiver["ChannelReceiver<br/>Local Webhook Receiver"]
    end

    Sender -- "1. Send HTTP Webhook" --> Server
    Client -- "2. Establish SSE long connection (keep-alive)" --> Server
    Server -- "3. Push message (SSE Event)" --> Client
    Client -- "4. Forward request (Local HTTP)" --> Receiver

    style Public_Internet fill:#f9f,stroke:#333,stroke-width:2px
    style Office_Internal_Network fill:#bbf,stroke:#333,stroke-width:2px
    style Server fill:#fff,stroke:#f66,stroke-width:3px
    style Client fill:#fff,stroke:#66f,stroke-width:3px
```

### Sequence Diagram

```mermaid
sequenceDiagram
    participant Web as External Sender (Webhook Source)
    participant CS as ChannelServer (Public)
    participant CC as ChannelClient (Intranet)
    participant CR as ChannelReceiver (Intranet)

    Note over CC, CS: Initialization
    CC->>CS: Establish SSE connection (HTTP GET /stream)
    activate CS
    CS-->>CC: 200 OK (Keep-alive)
    deactivate CS

    Note over Web, CR: Message Forwarding
    Web->>CS: POST /webhook/data (from internet)
    activate CS
    CS->>CS: Wrap message body as SSE Data Event
    CS-->>CC: Push SSE message (Event: message)
    CS->>Web: 200 OK (acknowledged)
    deactivate CS

    activate CC
    CC->>CC: Parse SSE packet
    CC->>CR: Forward local HTTP request (POST /local/endpoint)
    activate CR
    CR-->>CC: Return result
    deactivate CR
    CC->>CC: Log (optional)
    deactivate CC
```

---

## References

- Open-source client reference: [webhook.site CLI](https://github.com/webhooksite/cli)