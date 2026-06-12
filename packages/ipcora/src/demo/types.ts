/**
 * Domain types shared across the demo.
 */

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  createdAt: number;
}

export interface AppState {
  users: Map<string, UserRecord>;
  seq: number;
}

export interface AppContext {
  tenant: string;
  requestId: string;
  locale: string;
  isAdmin: boolean;
  currentUser?: { id: string; role: string };
}
