import { useState } from 'react';

interface LoginScreenProps {
  onLogin: (username: string, password: string) => boolean;
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    // Simulate login delay for demo
    setTimeout(() => {
      const loginAccepted = onLogin(username, password);
      if (!loginAccepted) {
        setError('Use the demo credentials: admin / demo');
      }
      setIsLoading(false);
    }, 1000);
  };

  return (
    <div className="login-screen">
      <div className="login-container">
        <div className="login-header">
          <div className="elevate-wordmark" aria-label="Elevate">
            {'ELEVATE'.split('').map((letter, index) => (
              <span key={`${letter}-${index}`}>{letter}</span>
            ))}
          </div>
          <div className="elevate-underlight" />
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <div className="form-group elevate-field">
            <input
              id="username"
              type="text"
              aria-label="Username"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setError('');
              }}
              placeholder="USER"
              required
            />
          </div>

          <div className="form-group elevate-field">
            <input
              id="password"
              type="password"
              aria-label="Password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError('');
              }}
              placeholder="PASSWORD"
              required
            />
          </div>

          {error && <div className="login-error" role="alert">{error}</div>}

          <button
            type="submit"
            className="login-btn"
            disabled={isLoading}
          >
            {isLoading ? (
              <>
                <div className="spinner-small"></div>
                Elevating...
              </>
            ) : (
              'Enter'
            )}
          </button>
        </form>
      </div>
    </div>
  );
}