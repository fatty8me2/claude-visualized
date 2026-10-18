import { Component, type ReactNode } from 'react';
import { Icon } from './Icon';

/** Keeps a render error from blanking the window: shows what broke and offers a reload. */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`render error${this.props.label ? ` in ${this.props.label}` : ''}`, error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="empty-state" data-testid="error-boundary">
        <div className="empty-card">
          <Icon name="warn" size="lg" />
          <div className="empty-title">Something went wrong{this.props.label ? ` in ${this.props.label}` : ''}</div>
          <code className="error-line">{error.message}</code>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => this.setState({ error: null })}>try again</button>
            <button className="primary" onClick={() => location.reload()}>
              reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
