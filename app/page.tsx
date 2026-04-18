'use client';

import { useState } from 'react';
import { Turnstile } from '@marsidev/react-turnstile';
import { verifyCaptchaAndStartSession } from './actions';
import { Activity } from 'lucide-react';
import Link from 'next/link';

export default function Home() {
  const [status, setStatus] = useState<'idle' | 'verifying' | 'error' | 'verified'>('idle');

  const handleVerify = async (token: string) => {
    setStatus('verifying');
    try {
      const res = await verifyCaptchaAndStartSession(token);
      if (res?.success) {
        setStatus('verified');
      }
    } catch (e) {
      console.error(e);
      setStatus('error');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
      <main className="max-w-xl w-full bg-white rounded-2xl shadow-xl overflow-hidden">
        <div className="p-8 text-center space-y-6">
          <h1 className="text-4xl font-bold text-gray-900 tracking-tight">VEChallenge</h1>
          
          {status !== 'verified' ? (
            <div className="pt-6 flex flex-col items-center space-y-4">
              <p className="text-xl text-gray-600">Please verify you are human to continue.</p>
              
              {status === 'idle' || status === 'error' ? (
                <div className="flex flex-col items-center gap-4 w-full">
                  {status === 'error' && (
                    <p className="text-red-500 text-sm font-medium">Verification failed. Please try again.</p>
                  )}
                  <div className="min-h-[65px] flex items-center justify-center">
                    <Turnstile 
                      siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY!} 
                      onSuccess={handleVerify}
                      options={{ theme: 'light' }}
                    />
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center p-4 gap-4">
                  <Activity className="w-8 h-8 animate-spin text-gray-400" />
                  <p className="text-sm text-gray-500 font-medium">Preparing your session...</p>
                </div>
              )}
            </div>
          ) : (
            <>
              <p className="text-xl text-gray-600">Can you estimate better than AI?</p>
              
              <div className="bg-blue-50 text-blue-800 p-4 rounded-lg text-sm text-left">
                <h3 className="font-semibold mb-2">Research Disclaimer</h3>
                <p>
                  This application is for research purposes. We only store your answers to the visual estimation tasks. 
                  <strong> We collect NO personally identifiable information.</strong> You remain completely anonymous.
                </p>
              </div>

              <div className="pt-6">
                <Link 
                  href="/play" 
                  className="inline-block w-full bg-black text-white font-semibold text-lg py-4 rounded-xl hover:bg-gray-800 transition-colors"
                >
                  Start Challenge
                </Link>
              </div>

              <div className="pt-6 border-t border-gray-100 mt-6">
                <p className="text-sm text-gray-500">
                  A research project by the <a href="https://kestrel-lab.github.io/" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-medium">Kestrel Lab</a>
                </p>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
