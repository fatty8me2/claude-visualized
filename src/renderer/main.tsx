import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/jetbrains-mono/700.css';
import './theme.css';
import './agentInfo.css';
import './graphCards.css';
import './local.css';
import './inbox.css';
import './peers.css';
import './graphFlow.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { MiniView } from './components/MiniView';

const root = createRoot(document.getElementById('root')!);
root.render(window.api.isMini ? <MiniView /> : <App />);
