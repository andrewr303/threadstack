interface Options {
  socketUrl: string;
  streamUrl: string;
  createSocket: (url: string) => WebSocket | null;
  createSource?: (url: string) => EventSource;
  disposeSocket: (socket: WebSocket) => void;
  isVerifiedHost: () => boolean;
  subscribeVerifiedHost: (observer: () => void) => () => void;
  onOpen: (sender: WebSocket | null) => void;
  onMessage: (data: unknown) => void;
  onLost: () => void;
  onClosed: () => void;
  onFallback: () => void;
}

/** Only a verified extension host may replace a blocked socket with the same-auth HTTP stream. */
export function createHostedLiveTransport(options: Options) {
  let disposed = false;
  let socket: WebSocket | null = null;
  let stream: EventSource | null = null;
  let socketFailed = false;
  let outageReported = false;
  let mode: "websocket" | "eventsource" = "websocket";
  const lost = () => {
    if (outageReported || disposed) return;
    outageReported = true;
    options.onLost();
  };
  const disposeSocket = () => {
    const current = socket; socket = null;
    if (!current) return;
    current.onopen = null; current.onerror = null; current.onclose = null; current.onmessage = null;
    options.disposeSocket(current);
  };
  const startStream = () => {
    if (disposed || stream || !options.isVerifiedHost()) return;
    mode = "eventsource";
    disposeSocket();
    options.onFallback();
    let next: EventSource;
    try { next = options.createSource ? options.createSource(options.streamUrl) : new EventSource(options.streamUrl, { withCredentials: true }); }
    catch { lost(); options.onClosed(); return; }
    stream = next;
    next.onopen = () => {
      if (disposed || stream !== next) return;
      outageReported = false;
      options.onOpen(null);
    };
    next.onmessage = event => { if (!disposed && stream === next) options.onMessage(event.data); };
    next.onerror = () => {
      if (disposed || stream !== next) return;
      lost();
      // Native EventSource owns temporary reconnects. Terminal failures use the
      // caller's existing bounded reconnect scheduler; never start a second channel.
      if (next.readyState === 2) {
        next.onopen = null; next.onmessage = null; next.onerror = null;
        stream = null; next.close(); options.onClosed();
      }
    };
  };
  const unsubscribe = options.subscribeVerifiedHost(() => {
    if (!options.isVerifiedHost() && stream) {
      const current = stream; stream = null;
      current.onopen = null; current.onmessage = null; current.onerror = null;
      current.close(); mode = "websocket";
      lost(); options.onClosed();
      return;
    }
    if (socketFailed && options.isVerifiedHost()) startStream();
  });
  const next = options.createSocket(options.socketUrl);
  if (!next) {
    socketFailed = true;
    if (options.isVerifiedHost()) startStream();
    else { lost(); options.onClosed(); }
  } else {
    socket = next;
    next.onopen = () => {
      if (disposed || socket !== next) return;
      outageReported = false;
      options.onOpen(next);
    };
    next.onmessage = event => { if (!disposed && socket === next) options.onMessage(event.data); };
    next.onerror = () => {
      if (disposed || socket !== next) return;
      socketFailed = true;
      if (options.isVerifiedHost()) startStream();
      else lost();
    };
    next.onclose = () => {
      if (disposed || socket !== next) return;
      socketFailed = true; socket = null;
      if (options.isVerifiedHost()) startStream();
      else { lost(); options.onClosed(); }
    };
  }
  return {
    mode: () => mode,
    dispose() {
      if (disposed) return;
      disposed = true; unsubscribe(); disposeSocket();
      if (stream) { stream.onopen = null; stream.onmessage = null; stream.onerror = null; stream.close(); stream = null; }
    },
  };
}
