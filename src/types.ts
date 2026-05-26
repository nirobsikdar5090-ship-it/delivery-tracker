export interface DeliveryLog {
  count: number;
  pricePerPiece: number;
}

export interface DeliveryLogs {
  [date: string]: DeliveryLog;
}

export interface UserDBData {
  email?: string;
  delivery_logs?: string; // stringified JSON representing DeliveryLogs
  price_per_piece?: string | number;
}

export type ActiveView = 'home' | 'history' | 'monthly' | 'settings';
