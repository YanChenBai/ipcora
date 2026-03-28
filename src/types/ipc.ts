export interface HandlerCallbackEvent {
  name: string;
  method: string;
  data?: any;
}

export interface SenderCallbackEvent {
  name: string;
  method: string;
  callback: (data: any) => void;
}

export interface WebContentsSendData {
  name: string;
  method: string;
  data?: any;
}
