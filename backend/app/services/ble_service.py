import asyncio
import logging
import struct
from typing import Optional, Dict
from bleak import BleakScanner
from bleak.backends.device import BLEDevice
from bleak.backends.scanner import AdvertisementData

logger = logging.getLogger(__name__)

# Mi Scale 2 (XMTZC05HM) BLE Constants
# Service UUIDs: 181b (Body Composition), 181d (Weight Scale)
BODY_COMP_SERVICE = "0000181b-0000-1000-8000-00805f9b34fb"
WEIGHT_SCALE_SERVICE = "0000181d-0000-1000-8000-00805f9b34fb"

class MiScaleBLEService:
    def __init__(self):
        self.latest_data: Dict = {
            "weight": 0.0,
            "impedance": None,
            "is_stabilized": False,
            "timestamp": 0,
            "device_id": None,
            "unit": "kg"
        }
        self.scanner: Optional[BleakScanner] = None
        self._running = False

    def _parse_xiaomi_data(self, data: bytes, device_id: str):
        """
        Mi Scale 2 (13 bytes)
        [0-1] Flags
        [2-8] Timestamp
        [9-10] Impedance
        [11-12] Weight
        """
        if len(data) < 13:
            return

        flags = data[0] | (data[1] << 8)
        is_stabilized = (flags & (1 << 9)) != 0
        
        # Units
        unit_lbs = (flags & (1 << 0)) != 0
        unit_jin = (flags & (1 << 4)) != 0
        
        raw_weight = (data[12] << 8) | data[11]
        weight = 0.0
        unit = "kg"
        
        if unit_lbs:
            weight = raw_weight / 100.0
            unit = "lbs"
        elif unit_jin:
            weight = raw_weight / 100.0 / 2.0 # Store as kg
            unit = "jin"
        else:
            weight = raw_weight / 200.0
            unit = "kg"

        raw_impedance = (data[10] << 8) | data[9]
        has_impedance = (raw_impedance > 0 and raw_impedance < 3000)

        self.latest_data = {
            "weight": round(weight, 2),
            "impedance": raw_impedance if has_impedance else None,
            "is_stabilized": is_stabilized,
            "timestamp": asyncio.get_event_loop().time(),
            "device_id": device_id,
            "unit": unit
        }
        logger.info(f"BLE Received: {weight}kg, stabilized={is_stabilized}, impedance={raw_impedance}")

    def _detection_callback(self, device: BLEDevice, advertisement_data: AdvertisementData):
        # Look for Mi Scale services in service_data
        for uuid, data in advertisement_data.service_data.items():
            if uuid.lower() in [BODY_COMP_SERVICE, WEIGHT_SCALE_SERVICE]:
                self._parse_xiaomi_data(data, device.address)
                break

    async def start(self):
        if self._running:
            return
        self._running = True
        logger.info("Starting Host BLE Scanner for Mi Scale...")
        try:
            self.scanner = BleakScanner(
                detection_callback=self._detection_callback,
                scanning_mode="active"
            )
            await self.scanner.start()
        except Exception as e:
            logger.error(f"Failed to start BLE scanner: {e}")
            self._running = False

    async def stop(self):
        if self.scanner:
            await self.scanner.stop()
        self._running = False

ble_service = MiScaleBLEService()
