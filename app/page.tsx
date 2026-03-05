import Link from 'next/link';

export default function Home() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
      <main className="max-w-xl w-full bg-white rounded-2xl shadow-xl overflow-hidden">
        <div className="p-8 text-center space-y-6">
          <h1 className="text-4xl font-bold text-gray-900 tracking-tight">VEChallenge</h1>
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
        </div>
      </main>
    </div>
  );
}
