/**
 * Copyright (c) Tiny Technologies, Inc. All rights reserved.
 * Licensed under the LGPL or a commercial license.
 * For LGPL see License.txt in the project root for license information.
 * For commercial licenses see https://www.tiny.cloud/
 */

import { Arr, Obj, Type } from '@ephox/katamari';
import { Remove, SugarElement } from '@ephox/sugar';
import createDompurify, { Config, DOMPurifyI } from 'dompurify';

import * as NodeType from '../../dom/NodeType';
import { cleanInvalidNodes } from '../../html/InvalidNodes';
import * as LegacyFilter from '../../html/LegacyFilter';
import * as ParserFilters from '../../html/ParserFilters';
import { isEmpty, isLineBreakNode, isPaddedWithNbsp, paddEmptyNode } from '../../html/ParserUtils';
import { BlobCache } from '../file/BlobCache';
import Tools from '../util/Tools';
import AstNode from './Node';
import Schema, { SchemaElement } from './Schema';

/**
 * This class parses HTML code into a DOM like structure of nodes it will remove redundant whitespace and make
 * sure that the node tree is valid according to the specified schema.
 * So for example: <p>a<p>b</p>c</p> will become <p>a</p><p>b</p><p>c</p>
 *
 * @example
 * var parser = new tinymce.html.DomParser({validate: true}, schema);
 * var rootNode = parser.parse('<h1>content</h1>');
 *
 * @class tinymce.html.DomParser
 * @version 3.4
 */

const makeMap = Tools.makeMap, each = Tools.each, explode = Tools.explode, extend = Tools.extend;

export interface ParserArgs {
  getInner?: boolean | number;
  forced_root_block?: boolean | string;
  context?: string;
  isRootContent?: boolean;
  format?: string;
  invalid?: boolean;
  no_events?: boolean;

  // TODO finish typing the parser args
  [key: string]: any;
}

export type ParserFilterCallback = (nodes: AstNode[], name: string, args: ParserArgs) => void;

export interface ParserFilter {
  name: string;
  callbacks: ParserFilterCallback[];
}

export interface DomParserSettings {
  allow_html_data_urls?: boolean;
  allow_svg_data_urls?: boolean;
  allow_conditional_comments?: boolean;
  allow_html_in_named_anchor?: boolean;
  allow_script_urls?: boolean;
  allow_unsafe_link_target?: boolean;
  convert_fonts_to_spans?: boolean;
  fix_list_elements?: boolean;
  font_size_legacy_values?: string;
  forced_root_block?: boolean | string;
  forced_root_block_attrs?: Record<string, string>;
  padd_empty_with_br?: boolean;
  preserve_cdata?: boolean;
  remove_trailing_brs?: boolean;
  root_name?: string;
  validate?: boolean;
  inline_styles?: boolean;
  blob_cache?: BlobCache;
  document?: Document;
}

interface DomParser {
  schema: Schema;
  addAttributeFilter: (name: string, callback: (nodes: AstNode[], name: string, args: ParserArgs) => void) => void;
  getAttributeFilters: () => ParserFilter[];
  addNodeFilter: (name: string, callback: (nodes: AstNode[], name: string, args: ParserArgs) => void) => void;
  getNodeFilters: () => ParserFilter[];
  parse: (html: string, args?: ParserArgs) => AstNode;
}

// For internal parser use only: a summary of the nodes that have been parsed
interface WalkResult {
  readonly invalidChildren: AstNode[];
  readonly matchedNodes: Record<string, AstNode[]>;
  readonly matchedAttributes: Record<string, AstNode[]>;
}

const configurePurify = (settings: DomParserSettings, schema: Schema): DOMPurifyI => {
  const purify = createDompurify();
  let uid = 0;
  const config: Config = {
    RETURN_DOM: true,
    ALLOW_DATA_ATTR: true,
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|about|blob|file|mailto|tel|callto|cid|xmpp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  };

  if (settings.allow_html_data_urls) {
    config.ADD_DATA_URI_TAGS = [ 'a', 'img' ];
  }

  // Deliberately ban all tags and attributes by default, and then un-ban them on demand in hooks
  // #comment has to be added as an allowed tag here though, otherwise dompurify will remove it automatically
  config.ALLOWED_TAGS = [ '#comment' ];
  config.ALLOWED_ATTR = [];

  // We use this to add new tags to the allow-list as we parse, if we notice that a tag has been banned but it's still in the schema
  purify.addHook('uponSanitizeElement', (ele, evt) => {
    const rule = schema.getElementRule(evt.tagName);
    if (!rule) {
      return;
    }
    if (!Obj.has(evt.allowedTags, evt.tagName)) {
      evt.allowedTags[evt.tagName] = true;
    }

    // Fix the attributes for the element, unwrapping it if we have to
    Arr.each(rule.attributesForced ?? [], (attr) =>
      ele.setAttribute(attr.name, attr.value === '{$uid}' ? `mce_${uid++}` : attr.value)
    );
    Arr.each(rule.attributesDefault ?? [], (attr) => {
      if (!ele.hasAttribute(attr.name)) {
        ele.setAttribute(attr.name, attr.value === '{$uid}' ? `mce_${uid++}` : attr.value);
      }
    });
    if (rule.attributesRequired) {
      if (!Arr.exists(rule.attributesRequired, (attr) => ele.hasAttribute(attr))) {
        Remove.unwrap(SugarElement.fromDom(ele));
        return;
      }
    }
    if (rule.removeEmptyAttrs && ele.attributes.length === 0) {
      Remove.unwrap(SugarElement.fromDom(ele));
      return;
    }
  });

  // Let's do the same thing for attributes
  purify.addHook('uponSanitizeAttribute', (ele, evt) => {
    evt.keepAttr = evt.attrName.startsWith('data-') || schema.isValid(ele.tagName.toLowerCase(), evt.attrName);
    if (evt.keepAttr) {
      if (!Obj.has(evt.allowedAttributes, evt.attrName)) {
        evt.allowedAttributes[evt.attrName] = true;
      }

      if (evt.attrName in schema.getBoolAttrs()) {
        evt.attrValue = evt.attrName;
      }
    }
  });

  purify.setConfig(config);

  return purify;
};

const transferChildren = (parent: AstNode, nativeParent: Node) => {
  const isSpecial = Arr.contains([ 'script', 'style' ], parent.name);
  Arr.each(nativeParent.childNodes, (nativeChild) => {
    const child = new AstNode(nativeChild.nodeName.toLowerCase(), nativeChild.nodeType);

    if (NodeType.isElement(nativeChild)) {
      Arr.each(nativeChild.attributes, (attr) => {
        child.attr(attr.name, attr.value);
      });
    } else if (NodeType.isComment(nativeChild) || NodeType.isText(nativeChild) || NodeType.isCData(nativeChild) || NodeType.isPi(nativeChild)) {
      child.value = nativeChild.data;
      if (isSpecial) {
        child.raw = true;
      }
    } else {
      // TODO: figure out if anything can arrive in this branch, before merging
      return;
    }

    transferChildren(child, nativeChild);
    parent.append(child);
  });
};

const walker = (root: AstNode, settings: DomParserSettings, schema: Schema, nodeFilters: Record<string, ParserFilterCallback[]>, attributeFilters: ParserFilter[]): WalkResult => {
  const state = { invalidChildren: [], matchedNodes: {}, matchedAttributes: {}};

  let node = root;
  let previous: AstNode;
  while ((previous = node), (node = node.walk())) {
    if (node.type === 1) {
      const elementRule = settings.validate ? schema.getElementRule(node.name) : {} as SchemaElement;
      if (!elementRule) {
        node.unwrap();
        node = previous;
        continue;
      }
      if (elementRule.outputName) {
        node.name = elementRule.outputName;
      }
    }
    filterNode(node, nodeFilters, attributeFilters, state);

    const parent = node.parent;
    if (!parent) {
      continue;
    }

    // Check if node is valid child of the parent node is the child is
    // unknown we don't collect it since it's probably a custom element
    if (schema.children[parent.name] && schema.children[node.name] && !schema.children[parent.name][node.name]) {
      state.invalidChildren.push(node);
    }
  }

  return state;
};

// All the dom operations we want to perform, regardless of whether we're trying to properly validate things
// e.g. removing excess whitespace
// e.g. removing empty nodes (or padding them with <br>)
// e.g. handling data-mce-bogus
const simplifyDom = (root: AstNode, schema: Schema, settings: DomParserSettings, args: ParserArgs) => {
  const nonEmptyElements = schema.getNonEmptyElements();
  const whitespaceElements = schema.getWhiteSpaceElements();
  const blockElements: Record<string, string> = extend(makeMap('script,style,head,html,body,title,meta,param'), schema.getBlockElements());
  const allWhiteSpaceRegExp = /[ \t\r\n]+/g;
  const startWhiteSpaceRegExp = /^[ \t\r\n]+/;
  const endWhiteSpaceRegExp = /[ \t\r\n]+$/;

  const hasWhitespaceParent = (node: AstNode) => {
    if (Obj.has(whitespaceElements, node.name)) {
      return true;
    } else if (node.parent) {
      return hasWhitespaceParent(node.parent);
    } else {
      return false;
    }
  };

  const isAtEdgeOfBlock = (node: AstNode, start: boolean): boolean => {
    const neighbour = start ? node.prev : node.next;
    if (Type.isNonNullable(neighbour)) {
      return false;
    }

    // Make sure our parent is actually a block, and also make sure it isn't a temporary "context" element
    // that we're probably going to unwrap as soon as we insert this content into the editor
    return Obj.has(blockElements, node.parent.name) && (node.parent !== root || args.isRootContent);
  };

  // Remove leading whitespace here, so that all whitespace in nodes to the left of us has already been fixed
  const preprocessText = (node: AstNode) => {
    if (!hasWhitespaceParent(node)) {
      let text = node.value;
      text = text.replace(allWhiteSpaceRegExp, ' ');

      if (isLineBreakNode(node.prev, blockElements) || isAtEdgeOfBlock(node, true)) {
        text = text.replace(startWhiteSpaceRegExp, '');
      }

      if (text.length === 0) {
        node.remove();
      } else {
        node.value = text;
      }
    }
  };

  // Removing trailing whitespace here, so that all whitespace in nodes to the right of us has already been fixed
  const postprocessText = (node: AstNode) => {
    if (!hasWhitespaceParent(node)) {
      let text = node.value;
      if (blockElements[node.next?.name] || isAtEdgeOfBlock(node, false)) {
        text = text.replace(endWhiteSpaceRegExp, '');
      }

      if (text.length === 0) {
        node.remove();
      } else {
        node.value = text;
      }
    }
  };

  // Check for invalid elements here, so we can remove them and avoid handling their children
  const preprocessElement = (node: AstNode) => {
    const bogus = node.attr('data-mce-bogus');
    if (bogus === 'all') {
      node.remove();
      return;
    } else if (bogus === '1' && !node.attr('data-mce-type')) {
      node.unwrap();
      return;
    }
  };

  // Check for empty nodes here, because children will have been processed and (if necessary) emptied / removed already
  const postprocessElement = (node: AstNode) => {
    const elementRule = schema.getElementRule(node.name);
    if (!elementRule) {
      return;
    }
    const isNodeEmpty = isEmpty(schema, nonEmptyElements, whitespaceElements, node);
    if (elementRule.removeEmpty && isNodeEmpty) {
      if (blockElements[node.name]) {
        node.remove();
      } else {
        node.unwrap();
      }
    } else if (elementRule.paddEmpty && (isNodeEmpty || isPaddedWithNbsp(node))) {
      paddEmptyNode(settings, args, blockElements, node);
    }
  };

  const nodes: AstNode[] = [];

  // Walk over the tree forwards, calling preprocess methods
  for (let node = root, lastNode = node; Type.isNonNullable(node); lastNode = node, node = node.walk()) {
    if (node.type === 1) {
      preprocessElement(node);
    } else if (node.type === 3) {
      preprocessText(node);
    }

    // check whether our preprocess methods removed the node
    if (Type.isNullable(node.parent) && node !== root) {
      node = lastNode;
    } else {
      nodes.push(node);
    }
  }

  // Walk over the tree backwards, calling postprocess methods
  Arr.eachr(nodes, (node) => {
    if (node.type === 1) {
      postprocessElement(node);
    } else if (node.type === 3) {
      postprocessText(node);
    }
  });
};

const filterNode = (node: AstNode, nodeFilters: Record<string, ParserFilterCallback[]>, attributeFilters: ParserFilter[], state: WalkResult): AstNode => {
  const name = node.name;
  // Run element filters
  if (name in nodeFilters) {
    const list = state.matchedNodes[name];

    if (list) {
      list.push(node);
    } else {
      state.matchedNodes[name] = [ node ];
    }
  }

  // Run attribute filters
  if (node.attributes) {
    let i = attributeFilters.length;
    while (i--) {
      const attrName = attributeFilters[i].name;

      if (attrName in node.attributes.map) {
        const list = state.matchedAttributes[attrName];

        if (list) {
          list.push(node);
        } else {
          state.matchedAttributes[attrName] = [ node ];
        }
      }
    }
  }

  return node;
};

const DomParser = (settings?: DomParserSettings, schema = Schema()): DomParser => {
  const nodeFilters: Record<string, ParserFilterCallback[]> = {};
  const attributeFilters: ParserFilter[] = [];

  settings = settings || {};
  settings.validate = 'validate' in settings ? settings.validate : true;
  settings.root_name = settings.root_name || 'body';

  const purify = configurePurify(settings, schema);

  /**
   * Adds a node filter function to the parser, the parser will collect the specified nodes by name
   * and then execute the callback once it has finished parsing the document.
   *
   * @example
   * parser.addNodeFilter('p,h1', function(nodes, name) {
   *  for (var i = 0; i < nodes.length; i++) {
   *   console.log(nodes[i].name);
   *  }
   * });
   * @method addNodeFilter
   * @param {String} name Comma separated list of nodes to collect.
   * @param {function} callback Callback function to execute once it has collected nodes.
   */
  const addNodeFilter = (name: string, callback: ParserFilterCallback) => {
    each(explode(name), (name) => {
      let list = nodeFilters[name];

      if (!list) {
        nodeFilters[name] = list = [];
      }

      list.push(callback);
    });
  };

  const getNodeFilters = (): ParserFilter[] => {
    const out = [];

    for (const name in nodeFilters) {
      if (Obj.has(nodeFilters, name)) {
        out.push({ name, callbacks: nodeFilters[name] });
      }
    }

    return out;
  };

  /**
   * Adds a attribute filter function to the parser, the parser will collect nodes that has the specified attributes
   * and then execute the callback once it has finished parsing the document.
   *
   * @example
   * parser.addAttributeFilter('src,href', function(nodes, name) {
   *  for (var i = 0; i < nodes.length; i++) {
   *   console.log(nodes[i].name);
   *  }
   * });
   * @method addAttributeFilter
   * @param {String} name Comma separated list of nodes to collect.
   * @param {function} callback Callback function to execute once it has collected nodes.
   */
  const addAttributeFilter = (name: string, callback: ParserFilterCallback) => {
    each(explode(name), (name) => {
      let i;

      for (i = 0; i < attributeFilters.length; i++) {
        if (attributeFilters[i].name === name) {
          attributeFilters[i].callbacks.push(callback);
          return;
        }
      }

      attributeFilters.push({ name, callbacks: [ callback ] });
    });
  };

  const getAttributeFilters = (): ParserFilter[] => [].concat(attributeFilters);

  /**
   * Parses the specified HTML string into a DOM like node tree and returns the result.
   *
   * @example
   * var rootNode = new DomParser({...}).parse('<b>text</b>');
   * @method parse
   * @param {String} html Html string to sax parse.
   * @param {Object} args Optional args object that gets passed to all filter functions.
   * @return {tinymce.html.Node} Root node containing the tree.
   */
  const parse = (html: string, args?: ParserArgs): AstNode => {
    const getRootBlockName = (name: string | boolean) => {
      if (name === false) {
        return '';
      } else if (name === true) {
        return 'p';
      } else {
        return name;
      }
    };

    args = args || {};
    const blockElements = extend(makeMap('script,style,head,html,body,title,meta,param'), schema.getBlockElements());
    const validate = settings.validate;
    const forcedRootBlockName = 'forced_root_block' in args ? args.forced_root_block : settings.forced_root_block;
    const rootBlockName = getRootBlockName(forcedRootBlockName);
    const startWhiteSpaceRegExp = /^[ \t\r\n]+/;
    const endWhiteSpaceRegExp = /[ \t\r\n]+$/;

    const addRootBlocks = (): void => {
      let node = rootNode.firstChild, rootBlockNode: AstNode | null = null;

      // Removes whitespace at beginning and end of block so:
      // <p> x </p> -> <p>x</p>
      const trim = (rootBlock: AstNode | null) => {
        if (rootBlock) {
          node = rootBlock.firstChild;
          if (node && node.type === 3) {
            node.value = node.value.replace(startWhiteSpaceRegExp, '');
          }

          node = rootBlock.lastChild;
          if (node && node.type === 3) {
            node.value = node.value.replace(endWhiteSpaceRegExp, '');
          }
        }
      };

      // Check if rootBlock is valid within rootNode for example if P is valid in H1 if H1 is the contentEditabe root
      if (!schema.isValidChild(rootNode.name, rootBlockName.toLowerCase())) {
        return;
      }

      while (node) {
        const next = node.next;

        if (node.type === 3 || (node.type === 1 && node.name !== 'p' &&
          !blockElements[node.name] && !node.attr('data-mce-type'))) {
          if (!rootBlockNode) {
            // Create a new root block element
            rootBlockNode = new AstNode(rootBlockName, 1);
            rootBlockNode.attr(settings.forced_root_block_attrs);
            rootNode.insert(rootBlockNode, node);
            rootBlockNode.append(node);
          } else {
            rootBlockNode.append(node);
          }
        } else {
          trim(rootBlockNode);
          rootBlockNode = null;
        }

        node = next;
      }

      trim(rootBlockNode);
    };

    const rootNode = new AstNode(args.context || settings.root_name, 11);
    // The settings object we pass to purify is completely ignored, because we called setConfig earlier, but it makes the type signatures work
    const element = purify.sanitize(html, { RETURN_DOM: true });
    transferChildren(rootNode, element);
    simplifyDom(rootNode, schema, settings, args);
    const state = walker(rootNode, settings, schema, nodeFilters, attributeFilters);

    // Fix invalid children or report invalid children in a contextual parsing
    if (validate && state.invalidChildren.length) {
      if (args.context) {
        const { pass: topLevelChildren, fail: otherChildren } = Arr.partition(state.invalidChildren, (child) => child.parent === rootNode);
        cleanInvalidNodes(otherChildren, schema, (newNode) => filterNode(newNode, nodeFilters, attributeFilters, state));
        args.invalid = topLevelChildren.length > 0;
      } else {
        cleanInvalidNodes(state.invalidChildren, schema, (newNode) => filterNode(newNode, nodeFilters, attributeFilters, state));
      }
    }

    // Wrap nodes in the root into block elements if the root is body
    if (rootBlockName && (rootNode.name === 'body' || args.isRootContent)) {
      addRootBlocks();
    }

    // Run filters only when the contents is valid
    if (!args.invalid) {
      // Run node filters
      for (const name in state.matchedNodes) {
        if (!Obj.has(state.matchedNodes, name)) {
          continue;
        }
        const list = nodeFilters[name];
        const nodes = state.matchedNodes[name];

        // Remove already removed children
        let fi = nodes.length;
        while (fi--) {
          if (!nodes[fi].parent) {
            nodes.splice(fi, 1);
          }
        }

        const l = list.length;
        for (let i = 0; i < l; i++) {
          list[i](nodes, name, args);
        }
      }

      // Run attribute filters
      const l = attributeFilters.length;
      for (let i = 0; i < l; i++) {
        const list = attributeFilters[i];

        if (list.name in state.matchedAttributes) {
          const nodes = state.matchedAttributes[list.name];

          // Remove already removed children
          let fi = nodes.length;
          while (fi--) {
            if (!nodes[fi].parent) {
              nodes.splice(fi, 1);
            }
          }

          for (let fi = 0, fl = list.callbacks.length; fi < fl; fi++) {
            list.callbacks[fi](nodes, list.name, args);
          }
        }
      }
    }

    return rootNode;
  };

  const exports = {
    schema,
    addAttributeFilter,
    getAttributeFilters,
    addNodeFilter,
    getNodeFilters,
    parse
  };

  ParserFilters.register(exports, settings);
  LegacyFilter.register(exports, settings);

  return exports;
};

export default DomParser;
