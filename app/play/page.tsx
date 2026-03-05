'use client';

import { useState, useEffect } from 'react';
import { fetchNextQuestions, submitAnswers } from '../actions';
import { Question } from '@prisma/client';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence, useMotionValue, useTransform } from 'framer-motion';
import { Check, X, ArrowRight, Activity, ChevronRight } from 'lucide-react';
import Image from 'next/image';

type AnswerData = {
  questionId: string;
  answerNum?: number | null;
  answerBool?: boolean | null;
};

export default function Play() {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<AnswerData[]>([]);
  const [loading, setLoading] = useState(true);
  const [showResults, setShowResults] = useState(false);
  const router = useRouter();

  const [numInput, setNumInput] = useState('');

  const x = useMotionValue(0);
  const backgroundColor = useTransform(
    x,
    [-150, 0, 150],
    ['#fee2e2', '#ffffff', '#dcfce7']
  );
  const rotate = useTransform(x, [-150, 150], [-10, 10]);

  useEffect(() => {
    x.stop();
    x.set(0);
  }, [currentIndex, x]);

  const loadQuestions = async () => {
    setLoading(true);
    try {
      const qs = await fetchNextQuestions();
      setQuestions(qs);
      setCurrentIndex(0);
      setAnswers([]);
      setShowResults(false);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadQuestions();
  }, []);

  const handleNext = async (answer: AnswerData) => {
    const newAnswers = [...answers, answer];
    setAnswers(newAnswers);
    setNumInput('');

    if (currentIndex < questions.length - 1) {
      setCurrentIndex(currentIndex + 1);
    } else {
      setLoading(true);
      await submitAnswers(newAnswers);
      setLoading(false);
      setShowResults(true);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Activity className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (questions.length === 0) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 p-4 text-center">
        <h2 className="text-2xl font-bold mb-4">You're amazing!</h2>
        <p className="text-gray-600 mb-8">You've answered all available questions.</p>
        <button onClick={() => router.push('/')} className="bg-black text-white px-6 py-3 rounded-lg hover:bg-gray-800 transition-colors">
          Go Home
        </button>
      </div>
    );
  }

  if (showResults) {
    let betterThanAiCount = 0;
    questions.forEach((q) => {
      const userAns = answers.find(a => a.questionId === q.id);
      const isBool = q.type === 'STABILITY' || q.type === 'FIT';
      
      let betterThanAi = false;
      
      if (isBool) {
        const isCorrect = userAns?.answerBool === q.actualAnswerBool;
        betterThanAi = isCorrect && (q.aiAnswerBool !== q.actualAnswerBool);
      } else {
        if (userAns?.answerNum != null && q.actualAnswerNum != null && q.aiAnswerNum != null) {
          const userDiff = Math.abs(userAns.answerNum - q.actualAnswerNum);
          const aiDiff = Math.abs(q.aiAnswerNum - q.actualAnswerNum);
          betterThanAi = userDiff < aiDiff;
        }
      }
      if (betterThanAi) betterThanAiCount++;
    });

    return (
      <div className="min-h-screen bg-gray-50 p-4 md:p-8">
        <div className="max-w-2xl mx-auto space-y-6">
          <div className="text-center mb-8">
            <h2 className="text-3xl font-bold text-gray-900">Your Results</h2>
            <p className="text-gray-600 mt-2">How did you do compared to AI?</p>
            <div className="mt-4 inline-block bg-blue-50 text-blue-800 px-4 py-2 rounded-lg font-medium">
              You did better than AI at {betterThanAiCount}/{questions.length} questions.
            </div>
          </div>

          <div className="space-y-4">
            {questions.map((q) => {
              const userAns = answers.find(a => a.questionId === q.id);
              const isBool = q.type === 'STABILITY' || q.type === 'FIT';
              
              let userStr = '';
              let actualStr = '';
              let aiStr = '';
              let betterThanAi = false;
              let isCorrect = false;
              
              if (isBool) {
                userStr = userAns?.answerBool ? 'Yes' : 'No';
                actualStr = q.actualAnswerBool ? 'Yes' : 'No';
                aiStr = q.aiAnswerBool ? 'Yes' : 'No';
                isCorrect = userAns?.answerBool === q.actualAnswerBool;
                betterThanAi = isCorrect && (q.aiAnswerBool !== q.actualAnswerBool);
              } else {
                userStr = `${userAns?.answerNum} ${q.unit}`;
                actualStr = `${q.actualAnswerNum} ${q.unit}`;
                aiStr = `${q.aiAnswerNum} ${q.unit}`;
                if (userAns?.answerNum != null && q.actualAnswerNum != null && q.aiAnswerNum != null) {
                  const userDiff = Math.abs(userAns.answerNum - q.actualAnswerNum);
                  const aiDiff = Math.abs(q.aiAnswerNum - q.actualAnswerNum);
                  betterThanAi = userDiff < aiDiff;
                  isCorrect = userDiff === 0;
                }
              }

              return (
                <div key={q.id} className="bg-white p-4 rounded-xl shadow-sm flex flex-col md:flex-row gap-4 items-center">
                  <div className="w-24 h-24 bg-gray-100 rounded-lg relative flex-shrink-0">
                    <Image src={q.imageUrl} alt={q.text} fill className="object-contain p-2" />
                  </div>
                  <div className="flex-grow space-y-2 w-full">
                    <p className="font-medium text-sm text-gray-900">{q.text}</p>
                    <div className="grid grid-cols-3 gap-2 text-sm text-center">
                      <div className={`p-2 rounded ${betterThanAi ? 'bg-green-100 text-green-900' : 'bg-blue-50 text-blue-900'}`}>
                        <span className="block text-xs uppercase opacity-70">You</span>
                        <span className="font-semibold">{userStr}</span>
                      </div>
                      <div className="bg-gray-50 p-2 rounded">
                        <span className="block text-xs text-gray-500 uppercase">Actual</span>
                        <span className="font-semibold">{actualStr}</span>
                      </div>
                      <div className={`p-2 rounded ${(!betterThanAi && isCorrect) || (!isBool && q.aiAnswerNum === q.actualAnswerNum) ? 'bg-green-100 text-green-900' : 'bg-purple-50 text-purple-900'}`}>
                        <span className="block text-xs uppercase opacity-70">AI</span>
                        <span className="font-semibold">{aiStr}</span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="pt-8 flex justify-center">
            <button 
              onClick={loadQuestions}
              className="bg-black text-white font-semibold text-lg px-8 py-4 rounded-xl hover:bg-gray-800 transition-colors flex items-center gap-2"
            >
              Play Again <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  const question = questions[currentIndex];
  const isBool = question.type === 'STABILITY' || question.type === 'FIT';

  const handleBoolAnswer = (val: boolean) => {
    handleNext({ questionId: question.id, answerBool: val });
  };

  const handleNumAnswer = (e: React.FormEvent) => {
    e.preventDefault();
    const val = parseFloat(numInput);
    if (!isNaN(val)) {
      handleNext({ questionId: question.id, answerNum: val });
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-lg mt-4 mb-8">
        <div className="flex justify-between text-sm font-medium text-gray-500 mb-2">
          <span>Question {currentIndex + 1} of {questions.length}</span>
        </div>
        <div className="h-2 bg-gray-200 rounded-full w-full overflow-hidden">
          <div 
            className="h-full bg-black transition-all duration-300"
            style={{ width: `${((currentIndex) / questions.length) * 100}%` }}
          />
        </div>
      </div>

      <AnimatePresence mode="wait">
        <motion.div 
          key={question.id}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.2 }}
          style={isBool ? { x, rotate, backgroundColor, cursor: 'grab' } : { backgroundColor: '#ffffff' }}
          drag={isBool ? "x" : false}
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={0.7}
          onDragEnd={(e, { offset }) => {
            const swipeThreshold = 100;
            if (offset.x > swipeThreshold) {
              handleBoolAnswer(true);
            } else if (offset.x < -swipeThreshold) {
              handleBoolAnswer(false);
            }
          }}
          whileDrag={{ cursor: 'grabbing' }}
          className="w-full max-w-lg rounded-3xl shadow-lg overflow-hidden flex flex-col min-h-[500px]"
        >
          <div className="relative w-full h-64 bg-gray-50 flex items-center justify-center p-4 border-b border-gray-100">
            <Image 
              src={question.imageUrl} 
              alt="Visual estimation" 
              fill 
              className="object-contain p-4"
              priority
            />
          </div>

          <div className="p-6 md:p-8 flex flex-col flex-grow">
            <h2 className="text-xl md:text-2xl font-semibold text-gray-900 text-center mb-8">
              {question.text}
            </h2>

            {isBool ? (
              <div className="flex gap-4 mt-auto">
                <button 
                  onClick={() => handleBoolAnswer(false)}
                  className="flex-1 py-4 bg-red-50 text-red-600 rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-red-100 transition-colors"
                >
                  <X className="w-6 h-6" /> No
                </button>
                <button 
                  onClick={() => handleBoolAnswer(true)}
                  className="flex-1 py-4 bg-green-50 text-green-600 rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-green-100 transition-colors"
                >
                  <Check className="w-6 h-6" /> Yes
                </button>
              </div>
            ) : (
              <form onSubmit={handleNumAnswer} className="mt-auto">
                <div className="relative flex items-center mb-4">
                  <input
                    type="number"
                    step="any"
                    required
                    value={numInput}
                    onChange={e => setNumInput(e.target.value)}
                    className="w-full text-center text-3xl font-bold py-4 bg-gray-50 text-gray-900 rounded-xl focus:outline-none focus:ring-2 focus:ring-black"
                    placeholder="0"
                    autoFocus
                  />
                  {question.unit && (
                    <span className="absolute right-6 text-gray-400 font-medium">
                      {question.unit}
                    </span>
                  )}
                </div>
                <button 
                  type="submit"
                  disabled={!numInput}
                  className="w-full bg-black text-white font-semibold py-4 rounded-xl flex items-center justify-center gap-2 hover:bg-gray-800 disabled:opacity-50 transition-all"
                >
                  Submit <ArrowRight className="w-5 h-5" />
                </button>
              </form>
            )}
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
