import { useEffect, useState } from 'preact/hooks';
import * as api from './api.js';
import { friendlyError } from './ui.jsx';

export function Login({ onDone }) {
    const [users, setUsers] = useState([]);
    const [handle, setHandle] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => { api.listUsers().then(setUsers); }, []);

    const submit = async event => {
        event.preventDefault();
        if (!handle.trim()) return setError('请输入账号');
        setBusy(true);
        setError('');
        try {
            await api.login(handle.trim(), password);
            onDone();
        } catch (e) {
            setError(friendlyError(e.message));
        } finally {
            setBusy(false);
        }
    };

    return (
        <main class="tl-login">
            <h1 class="tl-title">轻酒馆</h1>
            {users.length > 0 && (
                <div class="tl-user-list">
                    {users.map(u => (
                        <button type="button" class="tl-button tl-user" aria-pressed={handle === u.handle} onClick={() => setHandle(u.handle)}>
                            {u.avatar && <img class="tl-avatar" src={u.avatar} alt="" />}
                            <span>{u.name || u.handle}</span>
                        </button>
                    ))}
                </div>
            )}
            <form class="tl-form" onSubmit={submit}>
                <input class="tl-input" placeholder="账号" autocomplete="username" value={handle} onInput={e => setHandle(e.currentTarget.value)} />
                <input class="tl-input" type="password" placeholder="密码（没设可不填）" autocomplete="current-password" value={password} onInput={e => setPassword(e.currentTarget.value)} />
                {error && <p class="tl-error">{error}</p>}
                <button class="tl-button tl-primary" disabled={busy}>{busy ? '登录中…' : '登录'}</button>
            </form>
        </main>
    );
}
