import { create } from 'zustand';
import { useStore } from '../store';
import type { Read } from './stats';

export interface ReaderStatus {
  connected: boolean;
  running: boolean;
  mode?: string;
  host?: string | null;
  message?: string;
  powerTable?: number[];
  recorder?: { recording: boolean; path: string | null; count: number };
}

interface LiveState {
  socket: 'closed' | 'connecting' | 'open';
  status: ReaderStatus;
  log: string[];
}

export const useLive = create<LiveState>(() => ({
  socket: 'closed',
  status: { connected: false, running: false },
  log: [],
}));

const addLog = (m: string) =>
  useLive.setState((s) => ({ log: [...s.log.slice(-99), `${new Date().toLocaleTimeString()} ${m}`] }));

let ws: WebSocket | null = null;

export function openSocket() {
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  useLive.setState({ socket: 'connecting' });
  ws = new WebSocket(url);
  ws.onopen = () => useLive.setState({ socket: 'open' });
  ws.onclose = () => {
    useLive.setState({ socket: 'closed' });
    ws = null;
  };
  ws.onerror = () => addLog(`Cannot reach the reader bridge at ${url} – is server/app.py running?`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'reads') {
      const st = useStore.getState();
      if (st.captureSource === 'file' || st.captureSource === 'sim') st.clearCapture(); // live reads replace a loaded/simulated capture
      useStore.getState().addReads(msg.reads as Read[]);
    } else if (msg.type === 'status') {
      useLive.setState({ status: msg });
      if (msg.message) addLog(msg.message);
    } else if (msg.type === 'error') addLog(`Error: ${msg.message}`);
  };
}

export function send(cmd: Record<string, unknown>) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addLog('Not connected to the reader bridge');
    return;
  }
  ws.send(JSON.stringify(cmd));
}
