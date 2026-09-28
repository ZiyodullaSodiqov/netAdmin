import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { store } from './ui/store';
import './ui/styles.css';

createRoot(document.getElementById('root')!).render(<App />);

// Esc — asbobni bekor qilish
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') store.setTool({ kind: 'select' });
});
