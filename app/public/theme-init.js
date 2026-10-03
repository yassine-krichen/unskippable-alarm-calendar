// Applies the saved theme before first paint so a light-mode user never sees a dark flash.
// A separate file (not inline) so the desktop app's CSP can forbid inline scripts.
try {
  if (localStorage.getItem('alarm-calendar-theme') === 'light') {
    document.documentElement.classList.remove('dark');
  }
} catch {
  /* storage blocked: stay on the dark default */
}
