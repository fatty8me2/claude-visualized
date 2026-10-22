import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/jetbrains-mono/700.css';
import './theme.css';
import './overview.css';
import './agentInfo.css';
import './graphCards.css';
import './local.css';
import './inbox.css';
import './peers.css';
import './insights.css';
import './graphFlow.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MiniView } from './components/MiniView';

// lets CSS adapt to the window chrome (macOS traffic lights vs the Windows caption buttons)
document.documentElement.dataset.platform = window.api.platform;

const root = createRoot(document.getElementById('root')!);
root.render(<ErrorBoundary>{window.api.isMini ? <MiniView /> : <App />}</ErrorBoundary>);
