import {
  parseOutboundMessage,
  serializeMessage,
  type InboundMessage,
  type OutboundMessage,
} from "@agent/shared";

interface WsClientHandlers {
  onOpen: () => void;
  onClose: () => void;
  onMessage: (message: OutboundMessage) => void;
  onProtocolError: (message: string) => void;
}

export class WsClient {
  private socket: WebSocket | undefined;

  constructor(
    private readonly url: string,
    private readonly handlers: WsClientHandlers,
  ) {}

  connect(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) {
      return;
    }

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.handlers.onOpen();
    };

    socket.onclose = () => {
      this.handlers.onClose();
    };

    socket.onerror = () => {
      this.handlers.onProtocolError("WebSocket transport error");
    };

    socket.onmessage = (event: MessageEvent) => {
      void this.handleMessage(event.data);
    };
  }

  disconnect(): void {
    if (!this.socket) {
      return;
    }

    this.socket.close();
    this.socket = undefined;
  }

  send(message: InboundMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.handlers.onProtocolError("WebSocket is not connected");
      return;
    }

    this.socket.send(serializeMessage(message));
  }

  private async handleMessage(data: unknown): Promise<void> {
    const asText = await this.readPayload(data);

    try {
      const parsed = parseOutboundMessage(JSON.parse(asText) as unknown);
      this.handlers.onMessage(parsed);
    } catch {
      this.handlers.onProtocolError("Invalid runtime payload");
    }
  }

  private async readPayload(data: unknown): Promise<string> {
    if (typeof data === "string") {
      return data;
    }

    if (data instanceof ArrayBuffer) {
      return new TextDecoder().decode(data);
    }

    if (data instanceof Blob) {
      return data.text();
    }

    return String(data);
  }
}

export function createWsClient(url: string, handlers: WsClientHandlers): WsClient {
  return new WsClient(url, handlers);
}
