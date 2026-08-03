/**
 * Fan-out for "something the dashboard shows has changed".
 *
 * Deliberately a leaf module with no imports: services announce their changes
 * here without knowing anything about the HTTP layer that streams them out.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export function onDashboardChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Announce a change. Cheap and synchronous — listeners coalesce the work, so
 * calling this on every mutation costs almost nothing when nobody is watching.
 */
export function notifyDashboard(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error('[events] dashboard listener failed', error);
    }
  }
}
