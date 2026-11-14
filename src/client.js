import { createClientPlugin } from './client/plugin.mjs';
import resources from 'session-terms:locales';
import styles from './client/styles.css';

window.__ModuleLoader__.load({
  id: '@fairyonthetree/dsh-session-terms',
  factory(require) {
    return createClientPlugin({ React: require('react'), resources, styles });
  },
});
