import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Layout from '@/components/Layout';
import Dashboard from '@/pages/Dashboard';
import Waveform from '@/pages/Waveform';
import Tomography from '@/pages/Tomography';
import Events from '@/pages/Events';

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="waveform" element={<Waveform />} />
          <Route path="tomography" element={<Tomography />} />
          <Route path="events" element={<Events />} />
        </Route>
      </Routes>
    </Router>
  );
}
