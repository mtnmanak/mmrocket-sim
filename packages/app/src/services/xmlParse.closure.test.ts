import { expect, it } from 'vitest';
import { createJsXmlParser } from './xmlParseJs.js';
import { XmlBudgetExceededError } from './xmlParse.js';

it.each(['<!---->', '<?a?>', 'x<!---->', '<![CDATA[x]]>'])('bounds non-element XML nodes: %s', filler => {
  const parse = createJsXmlParser({ maxElements: 2, maxDepth: 2 });
  expect(() => parse(`<a>${filler.repeat(20)}</a>`)).toThrow(XmlBudgetExceededError);
});

it('bounds attributes before DOM construction', () => {
  const parse = createJsXmlParser({ maxElements: 2, maxDepth: 2 });
  expect(() => parse(`<a ${Array.from({ length: 20 }, (_, i) => `x${i}=""`).join(' ')}/>`))
    .toThrow(XmlBudgetExceededError);
});
