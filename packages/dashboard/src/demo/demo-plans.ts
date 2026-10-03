export interface DemoTicketPlan {
  title: string;
  body: string;
}

export interface DemoQuestionPlan {
  question: string;
  options: string[];
  recommendation: string;
}

export interface DemoVoyagePlan {
  goal: string;
  tickets: [DemoTicketPlan, DemoTicketPlan, DemoTicketPlan];
  question: DemoQuestionPlan;
  lesson: string;
}

export const DEMO_VOYAGE_PLANS: readonly DemoVoyagePlan[] = [
  {
    goal: 'Take deposits when a berth is booked',
    tickets: [
      {
        title: 'Deposit field on the berth form',
        body: 'Add a deposit amount to the booking form, validated against the berth rate.',
      },
      {
        title: 'Hold the deposit until check-in',
        body: 'Record the deposit as held and release it when the boat checks in.',
      },
      {
        title: 'Deposit line on the receipt',
        body: 'Show the deposit and what is left to pay on the emailed receipt.',
      },
    ],
    question: {
      question:
        'Refund a deposit automatically when a booking is cancelled more than 7 days out, or leave refunds to the harbour master?',
      options: ['Refund automatically', 'Leave it to the harbour master'],
      recommendation: 'Refund automatically',
    },
    lesson:
      'Money flows go behind a card: agents ask before anything that refunds or charges.',
  },
  {
    goal: 'Let crews check in from their phone',
    tickets: [
      {
        title: 'Check-in link in the arrival email',
        body: 'Send a one-time check-in link the morning a booking starts.',
      },
      {
        title: 'Mobile check-in page',
        body: 'A single page: confirm the boat name, length and arrival time.',
      },
      {
        title: 'Notify the office on check-in',
        body: 'Post the arrival to the office board as soon as a crew checks in.',
      },
    ],
    question: {
      question:
        'Should the check-in link expire at midnight on arrival day, or stay valid for the whole booking?',
      options: ['Expire at midnight', 'Valid for the whole booking'],
      recommendation: 'Expire at midnight',
    },
    lesson:
      'One-time links expire the same day; the reviewer bounced a link that never did.',
  },
  {
    goal: 'Show live berth availability on the map',
    tickets: [
      {
        title: 'Availability endpoint',
        body: 'Return free and booked berths for a date range in one query.',
      },
      {
        title: 'Colour berths on the marina map',
        body: 'Green for free, amber for arriving today, grey for booked.',
      },
      {
        title: 'Refresh the map on new bookings',
        body: 'Push booking changes to open maps without a reload.',
      },
    ],
    question: {
      question:
        'Count a berth as free while its boat is out on a day trip, or keep it booked?',
      options: ['Keep it booked', 'Count it as free'],
      recommendation: 'Keep it booked',
    },
    lesson:
      'Availability reads go through one query; the map never counts berths itself.',
  },
];

export const DEMO_PLANNER_REPLY =
  'Here is a ticket for that. Approve it, edit it or reject it; an approved ticket goes to the Driver in the next voyage.';
