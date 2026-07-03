#!/bin/bash
# Re-download the public-domain sigrok-dumps fixtures used by this test suite.
set -euo pipefail
BASE="https://raw.githubusercontent.com/sigrokproject/sigrok-dumps/master"
FILES=(
  "uart/hello_world/8n1/hello_world_8n1_9600.sr"
  "i2c/sensirion_sht2x/i2c-sht21-100khz-read-serial-hold.sr"
  "spi/spi-count-lsb.sr"
  "swd/stlink_openocd/init_write_0xabbabeeb.sr"
  "jtag/keil_mcb2140/keil_mcb2140_irscan_drscan.sr"
  "uart/modbus_rtu/wizmodbus/wizmodbus.sr"
)

cd "$(dirname "$0")"
for f in "${FILES[@]}"; do
  echo "Fetching $f"
  curl -L -o "$(basename "$f")" "$BASE/$f"
done

