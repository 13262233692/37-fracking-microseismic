from __future__ import annotations
import asyncio
import struct
import logging
from typing import Optional
from datetime import datetime
import numpy as np

try:
    from obspy import read as obspy_read
    from obspy.core import Stream
    HAS_OBSPY = True
except ImportError:
    HAS_OBSPY = False

from simulator import ring_buffer

logger = logging.getLogger(__name__)

MSEED_HEADER_SIZE = 64
DEFAULT_TCP_PORT = 18000


class MiniSEEDTCPServer:
    def __init__(self, host: str = "0.0.0.0", port: int = DEFAULT_TCP_PORT):
        self.host = host
        self.port = port
        self._server: Optional[asyncio.AbstractServer] = None
        self._running = False

    async def start(self) -> None:
        self._running = True
        self._server = await asyncio.start_server(
            self._handle_client, self.host, self.port
        )
        logger.info(f"MiniSEED TCP server listening on {self.host}:{self.port}")

    async def stop(self) -> None:
        self._running = False
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            logger.info("MiniSEED TCP server stopped")

    async def _handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        addr = writer.get_extra_info("peername")
        logger.info(f"TCP client connected from {addr}")
        try:
            while self._running:
                header = await reader.read(MSEED_HEADER_SIZE)
                if not header:
                    break
                if len(header) < MSEED_HEADER_SIZE:
                    break
                record_length = self._parse_record_length(header)
                remaining = record_length - MSEED_HEADER_SIZE
                data_bytes = b""
                while len(data_bytes) < remaining:
                    chunk = await reader.read(remaining - len(data_bytes))
                    if not chunk:
                        break
                    data_bytes += chunk
                full_record = header + data_bytes
                await self._process_mseed_record(full_record)
        except (ConnectionResetError, asyncio.IncompleteReadError):
            pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            logger.info(f"TCP client disconnected from {addr}")

    def _parse_record_length(self, header: bytes) -> int:
        try:
            if len(header) >= 30:
                year = struct.unpack(">H", header[20:22])[0]
                if 1950 < year < 2100:
                    return 4096
            return 4096
        except struct.error:
            return 4096

    async def _process_mseed_record(self, record: bytes) -> None:
        if not HAS_OBSPY:
            self._process_raw_record(record)
            return
        try:
            import io
            st = obspy_read(io.BytesIO(record), format="MSEED")
            for tr in st:
                station_id = tr.stats.station
                channel = tr.stats.channel[-1] if len(tr.stats.channel) >= 3 else "Z"
                if channel not in ("Z", "N", "E"):
                    channel = "Z"
                data = tr.data.astype(np.float64)
                timestamp = datetime.utcfromtimestamp(tr.stats.starttime.timestamp)
                ring_buffer.write(station_id, channel, data, timestamp)
        except Exception as e:
            logger.warning(f"Failed to parse MiniSEED record: {e}")
            self._process_raw_record(record)

    def _process_raw_record(self, record: bytes) -> None:
        try:
            if len(record) > 64:
                station_id = record[18:26].decode("ascii", errors="replace").strip()
                channel_code = record[16:18].decode("ascii", errors="replace").strip()
                if not station_id:
                    station_id = "UNK"
                ch = "Z"
                if "N" in channel_code.upper():
                    ch = "N"
                elif "E" in channel_code.upper():
                    ch = "E"
                payload = record[64:]
                if len(payload) >= 4:
                    n_samples = len(payload) // 4
                    try:
                        data = np.frombuffer(payload[: n_samples * 4], dtype=">i4").astype(np.float64)
                        data = data / max(np.max(np.abs(data)), 1.0)
                        timestamp = datetime.utcnow()
                        ring_buffer.write(station_id, ch, data, timestamp)
                    except Exception:
                        pass
        except Exception as e:
            logger.warning(f"Failed to process raw record: {e}")


tcp_server = MiniSEEDTCPServer()
