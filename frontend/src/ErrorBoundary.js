import React from 'react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('Beklenmeyen hata yakalandı:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 40, textAlign: 'center', fontFamily: 'sans-serif' }}>
          <h2>⚠️ Bir şeyler ters gitti</h2>
          <p style={{ color: '#6b7280', marginTop: 8 }}>
            Sayfa beklenmedik bir hatayla karşılaştı. Yeniden yüklemeyi deneyin.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: 16, padding: '8px 20px', borderRadius: 7, border: 'none', background: '#f97316', color: '#fff', cursor: 'pointer' }}
          >
            Sayfayı Yenile
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
