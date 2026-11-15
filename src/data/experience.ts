// Copied as is from the previous site. Update here when roles change.
export interface Role {
  title: string;
  company: string;
  period: string;
  points: string[];
}

export const experience: Role[] = [
  {
    title: 'Senior Software Design Engineer I (Frontend)',
    company: 'vimigo Technologies',
    period: 'Jul 2022 – Feb 2023',
    points: [
      'Took part in projects using file uploads, geolocation and camera features in Flutter',
      'Handled mobile application deployment',
      'Worked closely with the design and QA teams on user experience and requirements',
      'Demonstrated progress to the product owner every sprint as lead frontend developer of the talent acquisition app',
    ],
  },
  {
    title: 'Software Developer II (Frontend)',
    company: 'vimigo Technologies',
    period: 'Jul 2021 – Jun 2022',
    points: [
      'Developed Vimigo, a performance reward system that helps organisations grow',
      'Built mobile and web applications with Flutter',
      'Integrated a native RFID scanner SDK and collaborated with an external backend team',
      'Refactored legacy code to improve mobile app performance',
    ],
  },
  {
    title: 'Software Engineer (Backend)',
    company: 'Nettium',
    period: 'Feb 2020 – Jun 2021',
    points: [
      'Built .NET API applications connecting client dashboards to our database',
      'Worked with microservice architecture and domain-driven design',
      'Used NLog, Swagger and Dapper; wrote stored procedures in T-SQL',
    ],
  },
];

export const skills = {
  languages: ['Dart', 'JavaScript', 'HTML & CSS', 'T-SQL'],
  frameworks: ['Flutter', '.NET', 'Node.js', 'Bootstrap'],
  tools: ['VS Code', 'Android Studio', 'Firebase', 'Postman', 'GitHub', 'Jira'],
};
