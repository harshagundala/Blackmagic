export type RealtimeMode = "demo" | "provider";

export type RoomRole = "host" | "phone";

export type RoomPresence = {
  roomId: string;
  deviceId: string;
  role: RoomRole;
  joinedAt: number;
  lastSeenAt: number;
};

export type RoomSignal =
  | {
      type: "join" | "leave" | "heartbeat";
      presence: RoomPresence;
    }
  | {
      type: "sensor-frame";
      deviceId: string;
      at: number;
      micLevel: number;
      headingDegrees: number | null;
    }
  | {
      type: "calibration-range";
      from: string;
      to: string;
      meters: number;
      confidence: number;
    };

export type RealtimeConfig = {
  mode: RealtimeMode;
  provider: "ably" | "none";
  roomTtlSeconds: number;
};
