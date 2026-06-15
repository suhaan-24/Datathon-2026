import { useState, useEffect } from 'react'
import LoginPage from './components/LoginPage'
import Dashboard from './components/Dashboard'

function App() {
  const [auth, setAuth] = useState(null)
  const [flash, setFlash] = useState(false)

  useEffect(() => {
    const saved = localStorage.getItem('knowhere_auth')
    if (saved) {
      try { setAuth(JSON.parse(saved)) } catch { localStorage.removeItem('knowhere_auth') }
    }
  }, [])

  const handleLogin = (authData) => {
    localStorage.setItem('knowhere_auth', JSON.stringify(authData))
    setAuth(authData)
    setFlash(true)
    setTimeout(() => setFlash(false), 950)
  }

  const handleLogout = () => {
    localStorage.removeItem('knowhere_auth')
    setAuth(null)
  }

  return (
    <>
      {auth ? <Dashboard auth={auth} onLogout={handleLogout} /> : <LoginPage onLogin={handleLogin} />}
      {flash && <div className="login-flash" />}
    </>
  )
}

export default App
