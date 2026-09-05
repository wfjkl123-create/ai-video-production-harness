// Reusable quiz widget
// Usage: call initQuiz() after DOM is ready, or add data-quiz attributes

function initQuiz(containerEl) {
  const options = containerEl.querySelectorAll('.quiz-option');
  const feedback = containerEl.querySelector('.quiz-feedback');
  let answered = false;

  options.forEach(btn => {
    btn.addEventListener('click', () => {
      if (answered) return;
      answered = true;

      const isCorrect = btn.dataset.correct === 'true';

      options.forEach(b => {
        b.disabled = true;
        if (b.dataset.correct === 'true') b.classList.add('correct');
      });

      if (!isCorrect) {
        btn.classList.add('wrong');
        if (feedback) {
          feedback.textContent = feedback.dataset.wrong || '再想想看。正确答案已用绿色标出。';
          feedback.className = 'quiz-feedback show wrong';
        }
      } else {
        if (feedback) {
          feedback.textContent = feedback.dataset.correct || '答对了！';
          feedback.className = 'quiz-feedback show correct';
        }
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.quiz').forEach(initQuiz);
});
