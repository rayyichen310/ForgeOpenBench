# sigrok `.sr` test fixtures

Small curated captures from the public-domain [sigrok-dumps](https://github.com/sigrokproject/sigrok-dumps) corpus used to validate the in-browser `.sr` parser and the UART/I2C/SPI decoders.

| File | Source | Metadata | Use |
|------|--------|----------|-----|
| `hello_world_8n1_9600.sr` | `uart/hello_world/8n1/` | 625 kHz, 8 probes, TX on probe1 | UART decoder validation |
| `i2c-sht21-100khz-read-serial-hold.sr` | `i2c/sensirion_sht2x/` | 8 MHz, SCL on probe7, SDA on probe8 | I2C decoder validation |
| `spi-count-lsb.sr` | `spi/` | 400 kHz, 3 probes | SPI decoder validation |

## License

Per the sigrok-dumps README, all dump files are released into the public domain unless otherwise noted.

## Refreshing fixtures

Run `fetch-fixtures.sh` to re-download the files from the upstream repository.
