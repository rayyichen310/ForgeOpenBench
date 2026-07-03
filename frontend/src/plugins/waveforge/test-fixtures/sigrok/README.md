# sigrok `.sr` test fixtures

Small curated captures from the public-domain [sigrok-dumps](https://github.com/sigrokproject/sigrok-dumps) corpus used to validate the in-browser `.sr` parser and the UART/I2C/SPI/SWD/JTAG/Modbus RTU decoders.

| File | Source | Metadata | Use |
|------|--------|----------|-----|
| `hello_world_8n1_9600.sr` | `uart/hello_world/8n1/` | 625 kHz, 8 probes, TX on probe1 | UART decoder validation |
| `i2c-sht21-100khz-read-serial-hold.sr` | `i2c/sensirion_sht2x/` | 8 MHz, SCL on probe7, SDA on probe8 | I2C decoder validation |
| `spi-count-lsb.sr` | `spi/` | 400 kHz, 3 probes | SPI decoder validation |
| `init_write_0xabbabeeb.sr` | `swd/stlink_openocd/` | 8 MHz, SWCLK on probe1, SWDIO on probe2 | SWD decoder validation |
| `keil_mcb2140_irscan_drscan.sr` | `jtag/keil_mcb2140/` | 4 MHz, TCK on probe4, TMS on probe3, TDI on probe2, TDO on probe5 | JTAG decoder validation |
| `wizmodbus.sr` | `uart/modbus_rtu/wizmodbus/` | 1 MHz, TX on probe4 | Modbus RTU decoder validation |

## License

Per the sigrok-dumps README, all dump files are released into the public domain unless otherwise noted.

## Refreshing fixtures

Run `fetch-fixtures.sh` to re-download the files from the upstream repository.
