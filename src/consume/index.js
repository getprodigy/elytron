import uuid from 'uuid';
import { kafkacat, brokers } from '../../lib/run';
import { log, error } from '../../lib/logger';
import { BrokerError } from '../../lib/error';
import { produce } from '../produce';

let registered_consumers = {};
let run;
let spawn;

const delimiter = ':msg:';

const decorate_consumer = (Run, Spawn) => {
  run = Run;
  spawn = Spawn;
};

const list_topics = () => {
  const metadata = run(kafkacat, [
    '-L', // List broker metadata
    '-b',
    brokers,
    '-J', // Output as JSON
  ]);
  const parsed_metadata = JSON.parse(metadata);
  const all_topics = parsed_metadata.topics.map(item => item.topic);

  return all_topics;
};

const teardown_consumer = (topic, id) => {
  const target_consumer = registered_consumers[topic][id];

  target_consumer.stdout.destroy();
  target_consumer.stderr.destroy();

  delete registered_consumers[topic][id];

  return registered_consumers[topic];
};

const consume_multi_topics = (topics, work, group, offset, exit) => {
  let new_consumers = [];
  topics.forEach((topic) => {
    new_consumers.push(consume(topic, work, group, offset, exit));
  });

  return new_consumers;
};

const handle_consumer_data = (data, topic, id, work, exit) => {
  let parsed = data.toString().split(delimiter);
  log(`Consumed data from ${topic}: ${parsed}`);
  parsed.pop(); // Empty string after delimiter
  parsed.forEach((item) => {
    let results = work(item);
    let deserialized = {};

    try { deserialized = JSON.parse(item); }
    catch (err) { deserialized.response_topic = false; }

    if (deserialized.response_topic) produce(
      deserialized.response_topic, results
    );
  });

  if (exit) teardown_consumer(topic, id);

  return parsed;
};

const handle_consumer_error = (err) => error(
  `Received error from consumer: ${err.toString()}`
);

const handle_consumer_close = (code) => {
  log(`Consumer exited with code ${code}`);
  return code;
};

const register_consumer = (consumer, topic, id) => {
  registered_consumers[topic] = registered_consumers[topic] || {};
  registered_consumers[topic][id] = consumer;

  return registered_consumers[topic];
};

const validate_arguments = (topic, work) => {
  if (topic instanceof Array && topic.length) {
    return { multi: true };
  }

  if (! topic || typeof topic != 'string') throw new BrokerError(
    'A topic argument is required!  It must be either an Array or String.'
  );

  if (! work || typeof work != 'function') throw new BrokerError(
    'A work argument is required!  It must be a function.'
  );

  return true;
};

const consume = (topic, work, group, offset = 'beginning', exit = false) => {
  if (validate_arguments(topic, work).multi) return consume_multi_topics(
    topic, work, group, offset, exit
  );

  if (topic === '*') return consume(list_topics(), work, group, offset, exit);

  let consumer_type = group ? ['-G', group] : ['-C'];
  const id = uuid.v4();
  const consume_options = consumer_type.concat([
    '-b', brokers, '-t', topic, '-D', delimiter, '-o', offset, '-u'
  ]);

  log(`Consuming ${topic} at offset ${offset}`);
  const consumer = spawn(kafkacat, consume_options);
  consumer.stdout.on('data', data => handle_consumer_data(
    data, topic, id, work, exit
  ));
  consumer.stderr.on('data', data => handle_consumer_error(
    data, topic, work, exit
  ));
  consumer.on('close', handle_consumer_close);

  return register_consumer(consumer, topic, id);
};

const starve = (topic, id) => {
  if (! topic || typeof topic != 'string') throw new BrokerError(
    'A topic argument is required!  It must be either an Array or String.'
  );

  if (
    ! registered_consumers[topic] ||
    (id && ! registered_consumers[topic][id])
  ) throw new BrokerError('No consumer to starve!');

  if (id) return teardown_consumer(topic, id);

  Object.keys(registered_consumers[topic]).forEach((consumer_id) => {
    teardown_consumer(topic, consumer_id);
  });

  delete registered_consumers[topic];

  return registered_consumers;
};

export { consume, starve, decorate_consumer };