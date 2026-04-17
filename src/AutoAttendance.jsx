import { useState, useEffect } from 'react';
import { Phone, Headphones, Mic, Settings, BarChart3, Users, Clock, PhoneCall, Volume2, ChevronRight, Power, RefreshCw, Plus, Trash2, Edit, Download, Upload, Play } from 'lucide-react';

const API = 'http://localhost:3003/api';

export default function AutoAttendance() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState({ total: 0, answered: 0, missed: 0, byOption: [] });
  const [menus, setMenus] = useState([]);
  const [faqs, setFaqs] = useState([]);
  const [agents, setAgents] = useState([]);
  const [logs, setLogs] = useState([]);
  const [audios, setAudios] = useState([]);
  const [loading, setLoading] = useState(false);

  const tabs = [
    { id: 'dashboard', label: 'Dashboard', icon: BarChart3 },
    { id: 'menus', label: 'Menus IVR', icon: Settings },
    { id: 'faq', label: 'FAQ', icon: Mic },
    { id: 'agents', label: 'Agentes', icon: Users },
    { id: 'logs', label: 'Chamadas', icon: PhoneCall },
    { id: 'audio', label: 'Áudios', icon: Volume2 }
  ];

  useEffect(() => {
    fetchStatus();
    fetchStats();
    fetchMenus();
    fetchFaqs();
    fetchAgents();
    fetchLogs();
    fetchAudios();
  }, []);

  async function fetchStatus() {
    try {
      const res = await fetch(`${API}/asterisk/status`);
      const data = await res.json();
      setConnected(data.connected);
    } catch {}
  }

  async function fetchStats() {
    try {
      const res = await fetch(`${API}/statistics`);
      const data = await res.json();
      setStats(data);
    } catch {}
  }

  async function fetchMenus() {
    try {
      const res = await fetch(`${API}/menus`);
      const data = await res.json();
      setMenus(data);
    } catch {}
  }

  async function fetchFaqs() {
    try {
      const res = await fetch(`${API}/faq`);
      const data = await res.json();
      setFaqs(data);
    } catch {}
  }

  async function fetchAgents() {
    try {
      const res = await fetch(`${API}/agents`);
      const data = await res.json();
      setAgents(data);
    } catch {}
  }

  async function fetchLogs() {
    try {
      const res = await fetch(`${API}/call-logs`);
      const data = await res.json();
      setLogs(data);
    } catch {}
  }

  async function fetchAudios() {
    try {
      const res = await fetch(`${API}/audio`);
      const data = await res.json();
      setAudios(data);
    } catch {}
  }

  async function toggleConnection() {
    setLoading(true);
    try {
      if (connected) {
        await fetch(`${API}/asterisk/disconnect`, { method: 'POST' });
        setConnected(false);
      } else {
        const res = await fetch(`${API}/asterisk/connect`, { method: 'POST' });
        const data = await res.json();
        if (data.success) setConnected(true);
        else alert(data.error);
      }
    } catch (err) {
      alert('Erro: ' + err.message);
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="bg-gray-800 border-b border-gray-700 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-600 rounded-lg">
              <Phone className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold">Auto Attendance</h1>
              <p className="text-sm text-gray-400">Sistema de Atendimento Automatizado</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-4 py-2 bg-gray-700 rounded-lg">
              <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-sm">{connected ? 'Asterisk Online' : 'Asterisk Offline'}</span>
            </div>
            <button
              onClick={toggleConnection}
              disabled={loading}
              className={`p-2 rounded-lg ${connected ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'} disabled:opacity-50`}
            >
              <Power className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <div className="flex">
        <aside className="w-64 bg-gray-800 min-h-[calc(100vh-73px)] p-4">
          <nav className="space-y-2">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                  activeTab === tab.id
                    ? 'bg-indigo-600 text-white'
                    : 'text-gray-400 hover:bg-gray-700 hover:text-white'
                }`}
              >
                <tab.icon className="w-5 h-5" />
                {tab.label}
                {activeTab === tab.id && <ChevronRight className="w-4 h-4 ml-auto" />}
              </button>
            ))}
          </nav>
        </aside>

        <main className="flex-1 p-6">
          {activeTab === 'dashboard' && <Dashboard stats={stats} logs={logs.slice(0, 5)} />}
          {activeTab === 'menus' && <MenusView menus={menus} onRefresh={fetchMenus} />}
          {activeTab === 'faq' && <FAQView faqs={faqs} onRefresh={fetchFaqs} />}
          {activeTab === 'agents' && <AgentsView agents={agents} onRefresh={fetchAgents} />}
          {activeTab === 'logs' && <LogsView logs={logs} />}
          {activeTab === 'audio' && <AudioView audios={audios} onRefresh={fetchAudios} />}
        </main>
      </div>
    </div>
  );
}

function Dashboard({ stats, logs }) {
  const cards = [
    { label: 'Total de Chamadas', value: stats.total || 0, color: 'indigo' },
    { label: 'Atendidas', value: stats.answered || 0, color: 'green' },
    { label: 'Perdidas', value: stats.missed || 0, color: 'red' },
    { label: 'Opções Usadas', value: stats.byOption?.length || 0, color: 'blue' }
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {cards.map(card => (
          <div key={card.label} className={`bg-gray-800 rounded-xl p-6 border border-${card.color}-500/20`}>
            <span className="text-gray-400 text-sm">{card.label}</span>
            <p className="text-3xl font-bold mt-2">{card.value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-gray-800 rounded-xl p-6">
          <h3 className="text-lg font-semibold mb-4">Opções Mais Usadas</h3>
          <div className="space-y-4">
            {stats.byOption?.slice(0, 5).map((item, i) => (
              <div key={i} className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Opção {item.option_selected}</span>
                  <span className="text-gray-400">{item.count}</span>
                </div>
                <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-indigo-500 rounded-full"
                    style={{ width: `${Math.min(100, (item.count / (stats.total || 1)) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
            {(!stats.byOption || stats.byOption.length === 0) && (
              <p className="text-gray-500 text-sm">Nenhum dado disponível</p>
            )}
          </div>
        </div>

        <div className="bg-gray-800 rounded-xl p-6">
          <h3 className="text-lg font-semibold mb-4">Últimas Chamadas</h3>
          <div className="space-y-3">
            {logs.map(log => (
              <div key={log.id} className="flex items-center justify-between py-2 border-b border-gray-700">
                <div>
                  <p className="font-mono text-sm">{log.caller_id || 'Desconhecido'}</p>
                  <p className="text-xs text-gray-500">{log.created_at}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm">{log.option_selected ? `Opção ${log.option_selected}` : log.disposition}</p>
                  <p className="text-xs text-gray-500">{log.duration}s</p>
                </div>
              </div>
            ))}
            {logs.length === 0 && <p className="text-gray-500 text-sm">Nenhuma chamada registrada</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function MenusView({ menus, onRefresh }) {
  const [selectedMenu, setSelectedMenu] = useState(null);
  const [options, setOptions] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', audio_welcome: 'welcome', timeout_seconds: 5, max_retries: 2 });
  const [optionForm, setOptionForm] = useState({ key: '', action_type: 'transfer', action_value: '' });

  useEffect(() => {
    if (selectedMenu) {
      fetch(`${API}/menus/${selectedMenu.id}`)
        .then(r => r.json())
        .then(data => setOptions(data.options || []));
    }
  }, [selectedMenu]);

  async function saveMenu() {
    const method = selectedMenu ? 'PUT' : 'POST';
    const url = selectedMenu ? `${API}/menus/${selectedMenu.id}` : `${API}/menus`;
    await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form)
    });
    setShowForm(false);
    onRefresh();
  }

  async function saveOption() {
    await fetch(`${API}/menus/${selectedMenu.id}/options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(optionForm)
    });
    setOptionForm({ key: '', action_type: 'transfer', action_value: '' });
    const res = await fetch(`${API}/menus/${selectedMenu.id}`);
    const data = await res.json();
    setOptions(data.options || []);
  }

  async function deleteOption(id) {
    await fetch(`${API}/options/${id}`, { method: 'DELETE' });
    const res = await fetch(`${API}/menus/${selectedMenu.id}`);
    const data = await res.json();
    setOptions(data.options || []);
  }

  async function exportDialplan() {
    const res = await fetch(`${API}/menus/${selectedMenu.id}/dialplan`);
    const dialplan = await res.text();
    const blob = new Blob([dialplan], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dialplan-ivr-${selectedMenu.id}.conf`;
    a.click();
  }

  const actionTypes = [
    { value: 'transfer', label: 'Transferir para' },
    { value: 'play_audio', label: 'Reproduzir áudio' },
    { value: 'voicemail', label: 'Caixa postal' },
    { value: 'submenu', label: 'Submenu' },
    { value: 'hangup', label: 'Encerrar' }
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Menus IVR</h2>
        <button
          onClick={() => { setSelectedMenu(null); setForm({ name: '', description: '', audio_welcome: 'welcome', timeout_seconds: 5, max_retries: 2 }); setShowForm(true); }}
          className="px-4 py-2 bg-indigo-600 rounded-lg hover:bg-indigo-700 flex items-center gap-2"
        >
          <Plus className="w-4 h-4" /> Novo Menu
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-gray-800 rounded-xl p-4">
          <h3 className="font-semibold mb-4">Menus</h3>
          <div className="space-y-2">
            {menus.map(menu => (
              <button
                key={menu.id}
                onClick={() => setSelectedMenu(menu)}
                className={`w-full text-left p-3 rounded-lg ${selectedMenu?.id === menu.id ? 'bg-indigo-600' : 'bg-gray-700 hover:bg-gray-600'}`}
              >
                <p className="font-medium">{menu.name}</p>
                <p className="text-xs text-gray-400">{menu.description}</p>
              </button>
            ))}
            {menus.length === 0 && <p className="text-gray-500 text-sm">Nenhum menu criado</p>}
          </div>
        </div>

        <div className="lg:col-span-2 bg-gray-800 rounded-xl p-6">
          {selectedMenu ? (
            <>
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-lg font-semibold">{selectedMenu.name}</h3>
                <button onClick={exportDialplan} className="px-3 py-2 bg-gray-700 rounded-lg hover:bg-gray-600 flex items-center gap-2">
                  <Download className="w-4 h-4" /> Dialplan
                </button>
              </div>

              <div className="mb-6">
                <p className="text-sm text-gray-400 mb-2">Opções do Menu</p>
                <div className="space-y-2">
                  {options.map(opt => (
                    <div key={opt.id} className="flex items-center justify-between bg-gray-700 p-3 rounded-lg">
                      <div>
                        <span className="font-mono bg-indigo-600 px-2 py-1 rounded mr-3">{opt.key}</span>
                        <span className="text-sm text-gray-400">{actionTypes.find(a => a.value === opt.action_type)?.label}</span>
                        <span className="text-sm ml-2 font-mono">{opt.action_value}</span>
                      </div>
                      <button onClick={() => deleteOption(opt.id)} className="p-1 text-red-400 hover:text-red-300">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border-t border-gray-700 pt-4">
                <p className="text-sm text-gray-400 mb-2">Adicionar Opção</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Tecla (1-9, 0)"
                    value={optionForm.key}
                    onChange={e => setOptionForm({ ...optionForm, key: e.target.value })}
                    className="w-24 bg-gray-700 rounded px-3 py-2"
                  />
                  <select
                    value={optionForm.action_type}
                    onChange={e => setOptionForm({ ...optionForm, action_type: e.target.value })}
                    className="bg-gray-700 rounded px-3 py-2"
                  >
                    {actionTypes.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                  </select>
                  <input
                    type="text"
                    placeholder="Valor (SIP/fila, audio, etc)"
                    value={optionForm.action_value}
                    onChange={e => setOptionForm({ ...optionForm, action_value: e.target.value })}
                    className="flex-1 bg-gray-700 rounded px-3 py-2"
                  />
                  <button onClick={saveOption} className="px-4 py-2 bg-green-600 rounded-lg hover:bg-green-700">
                    Adicionar
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-64 text-gray-500">
              Selecione um menu para editar
            </div>
          )}
        </div>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-xl p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold mb-4">Novo Menu</h3>
            <div className="space-y-4">
              <input
                type="text"
                placeholder="Nome do menu"
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                className="w-full bg-gray-700 rounded px-4 py-2"
              />
              <input
                type="text"
                placeholder="Descrição"
                value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
                className="w-full bg-gray-700 rounded px-4 py-2"
              />
              <input
                type="text"
                placeholder="Áudio de boas-vindas (sem extensão)"
                value={form.audio_welcome}
                onChange={e => setForm({ ...form, audio_welcome: e.target.value })}
                className="w-full bg-gray-700 rounded px-4 py-2"
              />
              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="text-sm text-gray-400">Timeout (s)</label>
                  <input
                    type="number"
                    value={form.timeout_seconds}
                    onChange={e => setForm({ ...form, timeout_seconds: parseInt(e.target.value) })}
                    className="w-full bg-gray-700 rounded px-4 py-2 mt-1"
                  />
                </div>
                <div className="flex-1">
                  <label className="text-sm text-gray-400">Máx. tentativas</label>
                  <input
                    type="number"
                    value={form.max_retries}
                    onChange={e => setForm({ ...form, max_retries: parseInt(e.target.value) })}
                    className="w-full bg-gray-700 rounded px-4 py-2 mt-1"
                  />
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setShowForm(false)} className="px-4 py-2 bg-gray-700 rounded-lg">Cancelar</button>
                <button onClick={saveMenu} className="px-4 py-2 bg-indigo-600 rounded-lg">Salvar</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FAQView({ faqs, onRefresh }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ question: '', answer: '', keywords: '', category: '', priority: 0 });

  async function save() {
    await fetch(`${API}/faq`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form)
    });
    setShowForm(false);
    setForm({ question: '', answer: '', keywords: '', category: '', priority: 0 });
    onRefresh();
  }

  async function remove(id) {
    await fetch(`${API}/faq/${id}`, { method: 'DELETE' });
    onRefresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Perguntas Frequentes</h2>
        <button onClick={() => setShowForm(true)} className="px-4 py-2 bg-indigo-600 rounded-lg hover:bg-indigo-700 flex items-center gap-2">
          <Plus className="w-4 h-4" /> Nova Pergunta
        </button>
      </div>

      <div className="bg-gray-800 rounded-xl overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-700">
            <tr className="text-left text-sm">
              <th className="px-6 py-4">Pergunta</th>
              <th className="px-6 py-4">Resposta</th>
              <th className="px-6 py-4">Categoria</th>
              <th className="px-6 py-4">Consultas</th>
              <th className="px-6 py-4">Ações</th>
            </tr>
          </thead>
          <tbody>
            {faqs.map(faq => (
              <tr key={faq.id} className="border-t border-gray-700">
                <td className="px-6 py-4">{faq.question}</td>
                <td className="px-6 py-4 text-gray-400 max-w-xs truncate">{faq.answer}</td>
                <td className="px-6 py-4">
                  <span className="px-2 py-1 bg-gray-700 rounded text-xs">{faq.category || '-'}</span>
                </td>
                <td className="px-6 py-4 text-gray-400">{faq.hits}</td>
                <td className="px-6 py-4">
                  <button onClick={() => remove(faq.id)} className="p-1 text-red-400 hover:text-red-300">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {faqs.length === 0 && <div className="p-8 text-center text-gray-500">Nenhuma pergunta cadastrada</div>}
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-xl p-6 w-full max-w-lg">
            <h3 className="text-lg font-semibold mb-4">Nova Pergunta</h3>
            <div className="space-y-4">
              <input
                type="text"
                placeholder="Pergunta"
                value={form.question}
                onChange={e => setForm({ ...form, question: e.target.value })}
                className="w-full bg-gray-700 rounded px-4 py-2"
              />
              <textarea
                placeholder="Resposta"
                value={form.answer}
                onChange={e => setForm({ ...form, answer: e.target.value })}
                className="w-full bg-gray-700 rounded px-4 py-2 h-24"
              />
              <div className="grid grid-cols-2 gap-4">
                <input
                  type="text"
                  placeholder="Categoria"
                  value={form.category}
                  onChange={e => setForm({ ...form, category: e.target.value })}
                  className="bg-gray-700 rounded px-4 py-2"
                />
                <input
                  type="text"
                  placeholder="Keywords (separadas por vírgula)"
                  value={form.keywords}
                  onChange={e => setForm({ ...form, keywords: e.target.value })}
                  className="bg-gray-700 rounded px-4 py-2"
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setShowForm(false)} className="px-4 py-2 bg-gray-700 rounded-lg">Cancelar</button>
                <button onClick={save} className="px-4 py-2 bg-indigo-600 rounded-lg">Salvar</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AgentsView({ agents, onRefresh }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', extension: '', skills: '', max_calls: 5 });

  async function save() {
    await fetch(`${API}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form)
    });
    setShowForm(false);
    setForm({ name: '', extension: '', skills: '', max_calls: 5 });
    onRefresh();
  }

  async function remove(id) {
    await fetch(`${API}/agents/${id}`, { method: 'DELETE' });
    onRefresh();
  }

  const statusColors = { available: 'bg-green-500', busy: 'bg-red-500', away: 'bg-yellow-500', offline: 'bg-gray-500' };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Agentes</h2>
        <button onClick={() => setShowForm(true)} className="px-4 py-2 bg-indigo-600 rounded-lg hover:bg-indigo-700 flex items-center gap-2">
          <Plus className="w-4 h-4" /> Novo Agente
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {agents.map(agent => (
          <div key={agent.id} className="bg-gray-800 rounded-xl p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-12 h-12 bg-indigo-600 rounded-full flex items-center justify-center text-lg font-bold">
                {agent.name.split(' ').map(n => n[0]).join('')}
              </div>
              <div>
                <h3 className="font-semibold">{agent.name}</h3>
                <p className="text-gray-400 text-sm">Ramal {agent.extension}</p>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${statusColors[agent.status] || 'bg-gray-500'}`} />
                <span className="text-sm capitalize text-gray-400">{agent.status}</span>
              </div>
              <button onClick={() => remove(agent.id)} className="p-1 text-red-400 hover:text-red-300">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
      {agents.length === 0 && <div className="text-center text-gray-500 py-8">Nenhum agente cadastrado</div>}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-xl p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold mb-4">Novo Agente</h3>
            <div className="space-y-4">
              <input
                type="text"
                placeholder="Nome"
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                className="w-full bg-gray-700 rounded px-4 py-2"
              />
              <input
                type="text"
                placeholder="Ramal (ex: 1001)"
                value={form.extension}
                onChange={e => setForm({ ...form, extension: e.target.value })}
                className="w-full bg-gray-700 rounded px-4 py-2"
              />
              <input
                type="text"
                placeholder="Habilidades (separadas por vírgula)"
                value={form.skills}
                onChange={e => setForm({ ...form, skills: e.target.value })}
                className="w-full bg-gray-700 rounded px-4 py-2"
              />
              <div className="flex gap-2 justify-end">
                <button onClick={() => setShowForm(false)} className="px-4 py-2 bg-gray-700 rounded-lg">Cancelar</button>
                <button onClick={save} className="px-4 py-2 bg-indigo-600 rounded-lg">Salvar</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LogsView({ logs }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Registro de Chamadas</h2>
        <button className="px-4 py-2 bg-gray-700 rounded-lg hover:bg-gray-600 flex items-center gap-2">
          <Download className="w-4 h-4" /> Exportar
        </button>
      </div>

      <div className="bg-gray-800 rounded-xl overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-700">
            <tr className="text-left text-sm">
              <th className="px-6 py-4">Caller ID</th>
              <th className="px-6 py-4">Menu</th>
              <th className="px-6 py-4">Opção</th>
              <th className="px-6 py-4">Duração</th>
              <th className="px-6 py-4">Status</th>
              <th className="px-6 py-4">Data/Hora</th>
            </tr>
          </thead>
          <tbody>
            {logs.map(log => (
              <tr key={log.id} className="border-t border-gray-700">
                <td className="px-6 py-4 font-mono">{log.caller_id || '-'}</td>
                <td className="px-6 py-4">{log.menu_id}</td>
                <td className="px-6 py-4">
                  <span className="px-2 py-1 bg-indigo-500/20 text-indigo-400 rounded text-xs">
                    {log.option_selected || '-'}
                  </span>
                </td>
                <td className="px-6 py-4 text-gray-400">{log.duration}s</td>
                <td className="px-6 py-4">
                  <span className={`px-2 py-1 rounded text-xs ${
                    log.disposition === 'ANSWERED' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                  }`}>
                    {log.disposition || '-'}
                  </span>
                </td>
                <td className="px-6 py-4 text-gray-400 text-sm">{log.created_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {logs.length === 0 && <div className="p-8 text-center text-gray-500">Nenhuma chamada registrada</div>}
      </div>
    </div>
  );
}

function AudioView({ audios, onRefresh }) {
  const [uploading, setUploading] = useState(false);

  async function uploadAudio(file) {
    setUploading(true);
    const formData = new FormData();
    formData.append('audio', file);
    await fetch(`${API}/audio/upload`, { method: 'POST', body: formData });
    setUploading(false);
    onRefresh();
  }

  async function deleteAudio(filename) {
    await fetch(`${API}/audio/${filename}`, { method: 'DELETE' });
    onRefresh();
  }

  function handleUpload(e) {
    const file = e.target.files[0];
    if (file) uploadAudio(file);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Arquivos de Áudio</h2>
        <label className="px-4 py-2 bg-indigo-600 rounded-lg hover:bg-indigo-700 flex items-center gap-2 cursor-pointer">
          <Upload className="w-4 h-4" /> {uploading ? 'Enviando...' : 'Enviar Áudio'}
          <input type="file" accept=".wav,.gsm,.ulaw,.alaw" onChange={handleUpload} className="hidden" disabled={uploading} />
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {audios.map((audio, i) => (
          <div key={i} className="bg-gray-800 rounded-xl p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="p-3 bg-indigo-600/20 rounded-lg">
                <Volume2 className="w-6 h-6 text-indigo-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-medium truncate text-sm">{audio.name}</h4>
              </div>
            </div>
            <div className="flex gap-2">
              <audio src={`http://localhost:3003/audio/${audio.name}`} className="flex-1 h-8" controls />
              <button onClick={() => deleteAudio(audio.name)} className="p-2 bg-gray-700 rounded-lg hover:bg-gray-600 text-red-400">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
      {audios.length === 0 && <div className="text-center text-gray-500 py-8">Nenhum arquivo de áudio</div>}
    </div>
  );
}
