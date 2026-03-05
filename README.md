# VE Data Collection
This website is for collecting data on how humans do on visual estimation tasks.
We have tasks of five different kinds, that each ask the user to provide one of
the following:
- the distance between two things (answer: number)
- the angle between two things (answer: number)
- the size of a thing (answer: number)
- the stability of a structure (answer: boolean)
- whether one object can fit inside other or not (answer: boolean)

## Requirements
here's what we need:
- we have a db of (image, question, answer).
  - question and answer can be of the above mentioned types.
- we need to give the users the image and ask the questions, they will answer
    - the questions, images have to be chosen in such a way that we have an even distribution
    - we should sample questions by checking what questions have the least answers (potentially using probabilistic weighting).
    - we need to track how many times each q has been asked
    - a user should not get the same question twice, and they should not be able to answer multiple times for the same q etc
    - the number questions will have a unit associated with them and when the
    user is asked the question the unit should be known and then we can just
    compare the number.
    - for boolean questions it could be swipe left/right.
- Gameplay flow:
  - We initially ask the user a set of 5 questions.
  - At the end of the 5 questions, we show them a summary of their performance.
  - We then ask if they want to continue playing (getting another set of 5 questions).
- we can pose this as can you do better than ai, so for that we need the ai answer too, then we can show how much the difference is from the AI and from the actual answer

## Privacy & Tracking
- **Anonymous Sessions:** Users do not need to log in or create an account. We track users via an anonymous UUID stored in a persistent browser cookie/local storage to ensure they don't receive repeat questions and cannot answer the same question multiple times.
- **Data Collection Disclaimer:** The landing page must include a clear disclaimer stating that this application is for research purposes and that we only store their answers to the visual estimation tasks, collecting no personal identifiable information.

## Tools
- use `bun` for project management
