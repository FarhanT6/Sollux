/** Words and colors for repair requests, the same on the owner's pages and in the tenant portal. */
export const REPAIR_CATEGORIES: Record<string, string> = {
  PLUMBING: 'Plumbing', ELECTRICAL: 'Electrical', HVAC: 'Heating / AC', APPLIANCE: 'Appliance',
  PEST: 'Pests', LOCKS_DOORS: 'Locks / doors', ROOF_LEAK: 'Roof / leak', OTHER: 'Other',
};
export const URGENCY: Record<string, { label: string; color: string; hint: string }> = {
  EMERGENCY: { label: 'Emergency', color: '#ef4444', hint: 'Flooding, no heat in freezing weather, gas smell, sparking, no way to lock the door' },
  URGENT: { label: 'Urgent', color: '#F5A623', hint: 'Needs fixing within a day or two' },
  ROUTINE: { label: 'Routine', color: '#9ca3af', hint: 'Can be scheduled' },
};
export const REPAIR_STATUS: Record<string, { label: string; color: string }> = {
  OPEN: { label: 'Received', color: '#F5A623' },
  SCHEDULED: { label: 'Scheduled', color: '#60a5fa' },
  IN_PROGRESS: { label: 'In progress', color: '#60a5fa' },
  COMPLETED: { label: 'Completed', color: '#22c55e' },
  CANCELLED: { label: 'Cancelled', color: '#6b7280' },
};
