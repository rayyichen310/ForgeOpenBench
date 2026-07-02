import type { DecoderTab } from "./laDecoders";

export const CHANNEL_COLORS = [
  "#F59E0B","#60A5FA","#F87171","#FBBF24","#86EFAC",
  "#C084FC","#FB923C","#22D3EE","#F59E0B","#60A5FA",
  "#F87171","#FBBF24","#86EFAC","#C084FC","#FB923C","#22D3EE",
];

export interface LaChannel {
  id: number;
  label: string;
  color: string;
  enabled: boolean;
  visible: boolean;
  decoder: 'uart' | 'i2c' | 'spi' | null;
}

export interface DecoderConfigLoaded {
  tab: DecoderTab;
  uart: { baud: number; ch: number };
  i2c: { scl: number; sda: number; addrBits: 7 | 8 };
  spi: { mosi: number; miso: number; sck: number; cs: number; mode: 0 | 1 | 2 | 3; bits: 8 | 16; csActiveLow: boolean };
}

const CHANNELS_STORAGE_KEY = "waveforge:la:channels";
const DECODERS_STORAGE_KEY = "waveforge:la:decoders";

export function loadChannels(): LaChannel[] {
  try {
    const raw = localStorage.getItem(CHANNELS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LaChannel>[];
      if (Array.isArray(parsed) && parsed.length === 16) {
        return parsed.map((p, i) => ({
          id: typeof p.id === "number" ? p.id : i,
          label: typeof p.label === "string" ? p.label : `D${i}`,
          color: typeof p.color === "string" ? p.color : CHANNEL_COLORS[i],
          enabled: typeof p.enabled === "boolean" ? p.enabled : true,
          visible: typeof p.visible === "boolean" ? p.visible : true,
          decoder: p.decoder === "uart" || p.decoder === "i2c" || p.decoder === "spi" ? p.decoder : null,
        }));
      }
    }
  } catch { /* ignore */ }
  return Array.from({ length: 16 }, (_, i) => ({
    id: i,
    label: `D${i}`,
    color: CHANNEL_COLORS[i],
    enabled: true,
    visible: true,
    decoder: null,
  }));
}

export function saveChannels(channels: LaChannel[]) {
  try { localStorage.setItem(CHANNELS_STORAGE_KEY, JSON.stringify(channels)); } catch { /* ignore */ }
}

export function loadDecoders(): DecoderConfigLoaded {
  try {
    const raw = localStorage.getItem(DECODERS_STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        tab: ["uart", "i2c", "spi"].includes(p.tab) ? p.tab : "uart",
        uart: { baud: p.uart?.baud ?? 115200, ch: p.uart?.ch ?? 0 },
        i2c: { scl: p.i2c?.scl ?? 0, sda: p.i2c?.sda ?? 1, addrBits: p.i2c?.addrBits === 8 ? 8 : 7 },
        spi: {
          mosi: p.spi?.mosi ?? 0, miso: p.spi?.miso ?? 1, sck: p.spi?.sck ?? 2, cs: p.spi?.cs ?? 3,
          mode: [0, 1, 2, 3].includes(p.spi?.mode) ? p.spi.mode : 0,
          bits: p.spi?.bits === 16 ? 16 : 8,
          csActiveLow: p.spi?.csActiveLow !== false,
        },
      };
    }
  } catch { /* ignore */ }
  return {
    tab: "uart", uart: { baud: 115200, ch: 0 },
    i2c: { scl: 0, sda: 1, addrBits: 7 },
    spi: { mosi: 0, miso: 1, sck: 2, cs: 3, mode: 0, bits: 8, csActiveLow: true },
  };
}

export function saveDecoders(config: DecoderConfigLoaded) {
  try { localStorage.setItem(DECODERS_STORAGE_KEY, JSON.stringify(config)); } catch { /* ignore */ }
}

export const DEFAULT_BAUDS = [1200,2400,4800,9600,19200,38400,57600,115200,230400,460800,921600];

export const SAMPLE_RATES = [
  { label: "1 MHz",  hz: 1_000_000 },
  { label: "4 MHz",  hz: 4_000_000 },
  { label: "8 MHz",  hz: 8_000_000 },
  { label: "12 MHz", hz: 12_000_000 },
  { label: "24 MHz", hz: 24_000_000, eightBitOnly: true },
];

export const TIMEBASE_PRESETS = [
  { label: "1 µs/div",   s: 1e-6   },
  { label: "2 µs/div",   s: 2e-6   },
  { label: "5 µs/div",   s: 5e-6   },
  { label: "10 µs/div",  s: 1e-5   },
  { label: "20 µs/div",  s: 2e-5   },
  { label: "50 µs/div",  s: 5e-5   },
  { label: "100 µs/div", s: 1e-4   },
  { label: "200 µs/div", s: 2e-4   },
  { label: "500 µs/div", s: 5e-4   },
  { label: "1 ms/div",   s: 1e-3   },
  { label: "2 ms/div",   s: 2e-3   },
  { label: "5 ms/div",   s: 5e-3   },
  { label: "10 ms/div",  s: 1e-2   },
  { label: "20 ms/div",  s: 2e-2   },
  { label: "50 ms/div",  s: 5e-2   },
  { label: "100 ms/div", s: 0.1    },
  { label: "200 ms/div", s: 0.2    },
  { label: "500 ms/div", s: 0.5    },
  { label: "1 s/div",    s: 1.0    },
  { label: "2 s/div",    s: 2.0    },
  { label: "5 s/div",    s: 5.0    },
  { label: "10 s/div",   s: 10.0   },
  { label: "20 s/div",   s: 20.0   },
  { label: "50 s/div",   s: 50.0   },
  { label: "100 s/div",  s: 100.0  },
];

export const DEFAULT_CHANNEL_HEIGHT = 22;
export const DEFAULT_CHANNEL_GAP = 2;
export const DEFAULT_LABEL_WIDTH = 48;
export const DEFAULT_RING_CAPACITY = 8 * 1024 * 1024;
export const DEFAULT_JITTER_CAP_SAMPLES = 6_000_000;
