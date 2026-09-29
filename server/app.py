"""Reader bridge for crossmgr-triangulate.

    pip install -r requirements.txt
    python app.py            # http://127.0.0.1:18788  (serves ../web/dist if built)

WebSocket /ws protocol (JSON), a superset of crossmgr-antenna's:
  client -> server: {"cmd": "connect", "host": "192.168.1.50", "mock": false}
                    {"cmd": "configure", "antennas": [{"port":1,"txDbm":30,"enabled":true}], "rxSensDbm": -80,
                     "searchMode": "dual", "session": 0, "modeIndex": 1000, "channels": [1]}
                    {"cmd": "start"} | {"cmd": "stop"} | {"cmd": "disconnect"} | {"cmd": "status"}
                    {"cmd": "record", "label": "grid-1", "meta": {...}} | {"cmd": "stopRecord"}
  server -> client: {"type": "status", ..., "recorder": {...}}
                    {"type": "reads", "reads": [{"epc","port","rssi","phase","doppler","channel","ts","n"}]}
                    {"type": "error", "message": "..."}
REST: GET /api/health, GET /api/sessions, GET /api/sessions/{name}
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from llrp_client import LlrpReader, MockReader, ReaderConfig
from recorder import SESSIONS_DIR, Recorder, list_sessions

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("triangulate-server")


class Hub:
    """One reader session shared by all connected browser tabs."""

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.reader = None
        self.recorder = Recorder()
        self._buffer: list[dict] = []

    # called from reader threads
    def push_reads(self, reads: list[dict]) -> None:
        self.recorder.write(reads)
        if self.loop:
            self.loop.call_soon_threadsafe(self._buffer.extend, reads)

    def push_status(self, status: dict) -> None:
        if self.loop:
            msg = {**status, "recorder": self.recorder.status()}
            self.loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self.broadcast(msg)))

    def status(self, message: str = "") -> dict:
        base = self.reader.status(message) if self.reader else {
            "type": "status", "connected": False, "running": False, "message": message or "idle"}
        return {**base, "recorder": self.recorder.status()}

    async def broadcast(self, msg: dict) -> None:
        data = json.dumps(msg)
        for ws in list(self.clients):
            try:
                await ws.send_text(data)
            except Exception:
                self.clients.discard(ws)

    async def flush_loop(self) -> None:
        # batch reads every 50 ms to keep the socket light
        while True:
            await asyncio.sleep(0.05)
            if self._buffer:
                reads, self._buffer = self._buffer, []
                await self.broadcast({"type": "reads", "reads": reads})

    async def handle(self, msg: dict) -> None:
        cmd = msg.get("cmd")
        if cmd == "connect":
            if self.reader:
                await asyncio.to_thread(self.reader.disconnect)
            cls = MockReader if msg.get("mock") else LlrpReader
            self.reader = cls(self.push_reads, self.push_status)
            await asyncio.to_thread(self.reader.connect, msg.get("host", ""), int(msg.get("port", 5084)))
        elif cmd == "configure" and self.reader:
            await asyncio.to_thread(self.reader.configure, ReaderConfig.from_msg(msg))
        elif cmd == "start" and self.reader:
            await asyncio.to_thread(self.reader.start)
        elif cmd == "stop" and self.reader:
            await asyncio.to_thread(self.reader.stop)
        elif cmd == "disconnect" and self.reader:
            await asyncio.to_thread(self.reader.disconnect)
            self.reader = None
        elif cmd == "record":
            reader_cfg = self.reader.config.to_dict() if self.reader else {}
            path = self.recorder.start(str(msg.get("label", "session")), reader_cfg, msg.get("meta"))
            await self.broadcast(self.status(f"Recording to {path.name}"))
        elif cmd == "stopRecord":
            path = self.recorder.stop()
            await self.broadcast(self.status(f"Saved {path.name}" if path else "Not recording"))
        elif cmd == "status":
            await self.broadcast(self.status())
        else:
            raise ValueError(f"unknown or invalid command: {cmd}")


hub = Hub()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    hub.loop = asyncio.get_running_loop()
    task = asyncio.create_task(hub.flush_loop())
    yield
    task.cancel()
    hub.recorder.stop()
    if hub.reader:
        await asyncio.to_thread(hub.reader.disconnect)


app = FastAPI(title="crossmgr-triangulate reader bridge", lifespan=lifespan)


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True, "status": hub.status()}


@app.get("/api/sessions")
async def sessions() -> list[dict]:
    return list_sessions()


@app.get("/api/sessions/{name}")
async def session_file(name: str) -> FileResponse:
    path = (SESSIONS_DIR / name).resolve()
    if path.parent != SESSIONS_DIR.resolve() or not path.is_file():
        raise HTTPException(404, "no such session")
    return FileResponse(path, media_type="application/x-ndjson", filename=name)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    hub.clients.add(ws)
    try:
        await hub.handle({"cmd": "status"})
        while True:
            msg = json.loads(await ws.receive_text())
            try:
                await hub.handle(msg)
            except Exception as e:  # report errors to the UI instead of dropping the socket
                log.exception("command failed")
                await ws.send_text(json.dumps({"type": "error", "message": str(e)}))
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.discard(ws)


dist = Path(__file__).resolve().parent.parent / "web" / "dist"
if dist.exists():
    app.mount("/", StaticFiles(directory=dist, html=True), name="web")
else:

    @app.get("/", response_class=HTMLResponse)
    async def no_frontend() -> str:
        return (
            "<h2>crossmgr-triangulate backend is running</h2>"
            "<p>The web app is not built. Run <code>npm run build</code> in <code>web/</code> and restart, "
            "or use the dev server at <a href='http://localhost:5174'>localhost:5174</a>.</p>"
        )


if __name__ == "__main__":
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "18788")))
