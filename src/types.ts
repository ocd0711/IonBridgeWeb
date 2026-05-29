export type PortMetrics = {
  id: number;
  active: boolean;
  state: string;
  port_type: "A" | "C";
  attached: boolean;
  charging_duration_seconds: number;
  fc_protocol: number;
  current: number;
  voltage: number;
  die_temperature?: number;
  vin_value: number;
  session_id: number;
  session_charge: number;
  power_budget: number;
  pd_status: unknown | null;
};

export type SystemMetrics = {
  chip: string;
  cores: number;
  cpu_freq_mhz: number;
  idf_version: string;
  app_version: string;
  boot_time_seconds: number;
  reset_reason: number;
  free_heap: number;
};

export type TaskMetrics = {
  name: string;
  stack_watermark_bytes: number;
  cpu_percent: number;
};

export type WifiMetrics = {
  ssid: string;
  bssid: string;
  channel: number;
  rssi: number;
};

export type Metrics = {
  ports: PortMetrics[];
  system: SystemMetrics;
  tasks: TaskMetrics[];
  wifi: WifiMetrics;
};

export type PortHistory = {
  sample_period_ms: number;
  ports: Array<{
    port: number;
    samples: Array<{
      voltage: number;
      current: number;
      temperature_c?: number;
      ts?: number;
    }>;
  }>;
};

export type HeapMetrics = {
  total_free: number;
  total_allocated: number;
  largest_free_block: number;
  min_free: number;
  allocated_blocks: number;
  free_blocks: number;
  total_blocks: number;
};

export type MachineInfo = {
  psn: string;
  ble_mac: string;
  wifi_mac: string;
  hw_rev: string;
  device_model: string;
  device_name: string;
  product_family: string;
  product_color: string;
  esp32_version: string;
  mcu_version: string;
  fpga_version: string;
  zrlib_version: string;
  country_code: string;
  mdns_hostname: string;
};
