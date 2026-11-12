// Tiny shared app state.

export const state = {
  status: null, // /api/status response
  user: null, // { id, username, fullName, role }
  settings: null, // { restaurantName, address, phone, receiptFooter, timezone }
  realtimeLive: false, // Supabase Realtime connected on the server
};

export function timezone() {
  return (state.settings && state.settings.timezone) || 'Asia/Manila';
}

export function roleHome(role) {
  if (role === 'kitchen') return '#/kitchen';
  if (role === 'cashier') return '#/pos';
  return '#/dashboard';
}

export const ROLE_LABELS = { admin: 'Admin', cashier: 'Cashier', kitchen: 'Kitchen' };
